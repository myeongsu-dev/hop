use crate::state::{file_fingerprint, same_path, AppState, FileFingerprint};
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const WATCH_DEBOUNCE: Duration = Duration::from_millis(350);
pub const FINGERPRINT_RETRY_INTERVAL: Duration = Duration::from_millis(100);
pub const FINGERPRINT_RETRY_MAX_ATTEMPTS: usize = 5;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExternalChangeKind {
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalFileChangedPayload {
    pub doc_id: String,
    pub path: String,
    pub kind: ExternalChangeKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NotifiedChange {
    Modified(FileFingerprint),
    Deleted,
}

pub(crate) struct WatchedEntry {
    pub doc_id: String,
    pub window_label: String,
    pub path: PathBuf,
    pub last_notified: Option<NotifiedChange>,
    _debouncer: Option<Debouncer<notify::RecommendedWatcher>>,
}

#[derive(Default)]
pub struct FileWatcherManager {
    watches: Mutex<HashMap<String, WatchedEntry>>,
}

impl FileWatcherManager {
    pub(crate) fn is_watching(
        &self,
        doc_id: &str,
        window_label: &str,
        path: &Path,
    ) -> Result<bool, String> {
        let watches = self
            .watches
            .lock()
            .map_err(|_| "파일 감시 상태 잠금 실패".to_string())?;
        Ok(watches.get(doc_id).is_some_and(|entry| {
            entry.window_label == window_label && same_path(&entry.path, path)
        }))
    }

    pub fn watch(
        &self,
        app: AppHandle,
        window_label: String,
        doc_id: String,
        path: PathBuf,
    ) -> Result<(), String> {
        if self.is_watching(&doc_id, &window_label, &path)? {
            return Ok(());
        }

        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| format!("감시할 상위 디렉터리를 찾을 수 없습니다: {}", path.display()))?
            .to_path_buf();

        let app_handle = app.clone();
        let doc_id_clone = doc_id.clone();
        let win_label = window_label.clone();
        let watch_path = path.clone();

        let mut debouncer = new_debouncer(WATCH_DEBOUNCE, move |res: DebounceEventResult| {
            let Ok(events) = res else {
                return;
            };
            if !events
                .iter()
                .any(|event| event_matches_target(&event.path, &watch_path))
            {
                return;
            }

            let state = app_handle.state::<AppState>();
            let baseline = state
                .sessions
                .lock()
                .ok()
                .and_then(|sessions| sessions.source_info(&doc_id_clone));

            let Some((tracked_path, baseline_fp)) = baseline else {
                return;
            };

            if let Some(payload) = state.file_watcher.evaluate_and_record(
                &doc_id_clone,
                &tracked_path,
                baseline_fp.as_ref(),
            ) {
                let _ = app_handle.emit_to(&win_label, "hop-external-file-changed", payload);
            }
        })
        .map_err(|e| format!("파일 감시 초기화 실패: {}", e))?;

        debouncer
            .watcher()
            .watch(&parent, RecursiveMode::NonRecursive)
            .map_err(|e| format!("디렉터리 감시 등록 실패: {} ({})", parent.display(), e))?;

        let mut watches = self
            .watches
            .lock()
            .map_err(|_| "파일 감시 상태 잠금 실패".to_string())?;
        watches.insert(
            doc_id.clone(),
            WatchedEntry {
                doc_id,
                window_label,
                path,
                last_notified: None,
                _debouncer: Some(debouncer),
            },
        );
        Ok(())
    }

    pub fn unwatch(&self, doc_id: &str) {
        if let Ok(mut watches) = self.watches.lock() {
            watches.remove(doc_id);
        }
    }

    pub fn unwatch_for_window(&self, window_label: &str) {
        if let Ok(mut watches) = self.watches.lock() {
            watches.retain(|_, entry| entry.window_label != window_label);
        }
    }

    pub fn reset_notified(&self, doc_id: &str) {
        if let Ok(mut watches) = self.watches.lock() {
            if let Some(entry) = watches.get_mut(doc_id) {
                entry.last_notified = None;
            }
        }
    }

    pub fn acknowledge_change(&self, doc_id: &str) -> Result<(), String> {
        let mut watches = self
            .watches
            .lock()
            .map_err(|_| "파일 감시 상태 잠금 실패".to_string())?;
        let Some(entry) = watches.get_mut(doc_id) else {
            return Ok(());
        };
        match file_fingerprint(&entry.path) {
            Ok(fp) => {
                entry.last_notified = Some(NotifiedChange::Modified(fp));
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                entry.last_notified = Some(NotifiedChange::Deleted);
            }
            Err(_) => {}
        }
        Ok(())
    }

    pub(crate) fn evaluate_and_record(
        &self,
        doc_id: &str,
        tracked_path: &Path,
        baseline: Option<&FileFingerprint>,
    ) -> Option<ExternalFileChangedPayload> {
        self.evaluate_and_record_with_reader(
            doc_id,
            tracked_path,
            baseline,
            || file_fingerprint(tracked_path),
            FINGERPRINT_RETRY_MAX_ATTEMPTS,
            FINGERPRINT_RETRY_INTERVAL,
        )
    }

    pub(crate) fn evaluate_and_record_with_reader<F>(
        &self,
        doc_id: &str,
        tracked_path: &Path,
        baseline: Option<&FileFingerprint>,
        reader: F,
        max_attempts: usize,
        retry_interval: Duration,
    ) -> Option<ExternalFileChangedPayload>
    where
        F: FnMut() -> std::io::Result<FileFingerprint>,
    {
        if !self.watches.lock().ok()?.contains_key(doc_id) {
            return None;
        }

        let current_fp = match read_fingerprint_with_retry(reader, max_attempts, retry_interval) {
            Ok(fp) => fp,
            Err(err) => {
                eprintln!(
                    "[file-watch] 파일 지문 읽기 실패(재시도 {}회 후 보류): {} ({})",
                    max_attempts.max(1),
                    tracked_path.display(),
                    err
                );
                return None;
            }
        };

        let mut watches = self.watches.lock().ok()?;
        let entry = watches.get_mut(doc_id)?;

        let kind = decide_external_change(baseline, current_fp.as_ref(), &mut entry.last_notified)?;
        Some(ExternalFileChangedPayload {
            doc_id: entry.doc_id.clone(),
            path: tracked_path.to_string_lossy().to_string(),
            kind,
        })
    }
}

pub(crate) fn read_fingerprint_with_retry<F>(
    mut reader: F,
    max_attempts: usize,
    retry_interval: Duration,
) -> std::io::Result<Option<FileFingerprint>>
where
    F: FnMut() -> std::io::Result<FileFingerprint>,
{
    let attempts = max_attempts.max(1);
    for attempt in 0..attempts {
        match reader() {
            Ok(fp) => return Ok(Some(fp)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                if attempt + 1 == attempts {
                    return Err(err);
                }
                if !retry_interval.is_zero() {
                    std::thread::sleep(retry_interval);
                }
            }
        }
    }
    unreachable!()
}

pub(crate) fn decide_external_change(
    baseline: Option<&FileFingerprint>,
    current: Option<&FileFingerprint>,
    last_notified: &mut Option<NotifiedChange>,
) -> Option<ExternalChangeKind> {
    match current {
        None => {
            if *last_notified == Some(NotifiedChange::Deleted) {
                return None;
            }
            *last_notified = Some(NotifiedChange::Deleted);
            Some(ExternalChangeKind::Deleted)
        }
        Some(current_fp) => {
            if let Some(base) = baseline {
                if !content_differs(base, current_fp) {
                    *last_notified = None;
                    return None;
                }
            }
            if let Some(NotifiedChange::Modified(prev_fp)) = last_notified {
                if !content_differs(prev_fp, current_fp) {
                    return None;
                }
            }
            *last_notified = Some(NotifiedChange::Modified(current_fp.clone()));
            Some(ExternalChangeKind::Modified)
        }
    }
}

pub(crate) fn content_differs(left: &FileFingerprint, right: &FileFingerprint) -> bool {
    left.len != right.len || left.content_hash != right.content_hash
}

pub(crate) fn event_matches_target(event_path: &Path, target_path: &Path) -> bool {
    let Some(event_name) = event_path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let Some(target_name) = target_path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if cfg!(windows) {
        event_name.eq_ignore_ascii_case(target_name)
    } else {
        event_name == target_name
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::atomic_write;
    use std::sync::mpsc;

    fn make_fp(len: u64, modified_millis: u64, content_hash: u32) -> FileFingerprint {
        FileFingerprint {
            len,
            modified_millis,
            content_hash,
        }
    }

    fn insert_test_entry(manager: &FileWatcherManager, doc_id: &str, path: PathBuf) {
        insert_test_entry_for_window(manager, doc_id, "main", path);
    }

    fn insert_test_entry_for_window(
        manager: &FileWatcherManager,
        doc_id: &str,
        window_label: &str,
        path: PathBuf,
    ) {
        manager.watches.lock().unwrap().insert(
            doc_id.to_string(),
            WatchedEntry {
                doc_id: doc_id.to_string(),
                window_label: window_label.to_string(),
                path,
                last_notified: None,
                _debouncer: None,
            },
        );
    }

    #[test]
    fn event_matches_target_filters_by_file_name() {
        let target = PathBuf::from("C:\\docs\\report.hwp");
        assert!(event_matches_target(
            Path::new("C:\\docs\\report.hwp"),
            &target
        ));
        assert!(!event_matches_target(
            Path::new("C:\\docs\\report.hwp.hop-save-123.tmp"),
            &target
        ));
        assert!(!event_matches_target(
            Path::new("C:\\docs\\other.hwp"),
            &target
        ));
        if cfg!(windows) {
            assert!(event_matches_target(
                Path::new("C:\\docs\\REPORT.HWP"),
                &target
            ));
        }
    }

    #[test]
    fn content_differs_ignores_mtime_only_changes() {
        let a = make_fp(100, 1000, 0x12345678);
        let b = make_fp(100, 2000, 0x12345678);
        let c = make_fp(100, 2000, 0xdeadbeef);
        let d = make_fp(101, 2000, 0x12345678);

        assert!(!content_differs(&a, &b));
        assert!(content_differs(&a, &c));
        assert!(content_differs(&a, &d));
    }

    #[test]
    fn decide_external_change_deduplicates_same_modification_and_allows_next() {
        let base = make_fp(10, 100, 1);
        let mut last = None;

        // Same content, different mtime -> ignored
        assert_eq!(
            decide_external_change(Some(&base), Some(&make_fp(10, 200, 1)), &mut last),
            None
        );

        // Modified content -> notified once
        let mod1 = make_fp(12, 300, 2);
        assert_eq!(
            decide_external_change(Some(&base), Some(&mod1), &mut last),
            Some(ExternalChangeKind::Modified)
        );

        // Duplicate event for same content -> ignored
        assert_eq!(
            decide_external_change(Some(&base), Some(&make_fp(12, 400, 2)), &mut last),
            None
        );

        // Subsequent new modification -> notified again
        let mod2 = make_fp(15, 500, 3);
        assert_eq!(
            decide_external_change(Some(&base), Some(&mod2), &mut last),
            Some(ExternalChangeKind::Modified)
        );
    }

    #[test]
    fn decide_external_change_handles_delete_and_recreate_without_duplicates() {
        let base = make_fp(10, 100, 1);
        let mut last = None;

        assert_eq!(
            decide_external_change(Some(&base), None, &mut last),
            Some(ExternalChangeKind::Deleted)
        );
        // Duplicate delete -> ignored
        assert_eq!(
            decide_external_change(Some(&base), None, &mut last),
            None
        );
        // Recreated with new content -> Modified
        assert_eq!(
            decide_external_change(Some(&base), Some(&make_fp(20, 200, 99)), &mut last),
            Some(ExternalChangeKind::Modified)
        );
    }

    #[test]
    fn manager_detects_external_change_and_tracks_acknowledgement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.hwp");
        atomic_write(&path, b"initial").unwrap();
        let baseline = file_fingerprint(&path).unwrap();

        let manager = FileWatcherManager::default();
        insert_test_entry(&manager, "doc-1", path.clone());

        // External write is detected immediately without time-based suppression
        atomic_write(&path, b"changed-content").unwrap();
        let payload = manager
            .evaluate_and_record("doc-1", &path, Some(&baseline))
            .expect("should detect external change");
        assert_eq!(payload.kind, ExternalChangeKind::Modified);

        // Second check without new change is deduplicated
        assert_eq!(
            manager.evaluate_and_record("doc-1", &path, Some(&baseline)),
            None
        );

        // Reset notified then acknowledge keeps current disk state suppressed
        manager.reset_notified("doc-1");
        manager.acknowledge_change("doc-1").unwrap();
        assert_eq!(
            manager.evaluate_and_record("doc-1", &path, Some(&baseline)),
            None
        );
    }

    #[test]
    fn manager_handles_deleted_file_without_crashing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deleted.hwp");
        atomic_write(&path, b"initial").unwrap();
        let baseline = file_fingerprint(&path).unwrap();

        let manager = FileWatcherManager::default();
        insert_test_entry(&manager, "doc-del", path.clone());

        std::fs::remove_file(&path).unwrap();
        let payload = manager
            .evaluate_and_record("doc-del", &path, Some(&baseline))
            .expect("should report deletion");
        assert_eq!(payload.kind, ExternalChangeKind::Deleted);

        // Duplicate deletion check is suppressed
        assert_eq!(
            manager.evaluate_and_record("doc-del", &path, Some(&baseline)),
            None
        );
    }

    #[test]
    fn debounced_parent_watcher_detects_atomic_replace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("atomic.hwp");
        atomic_write(&path, b"v1").unwrap();

        let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
        let target = path.clone();
        let mut debouncer = new_debouncer(Duration::from_millis(100), move |res: DebounceEventResult| {
            if let Ok(events) = res {
                let matched: Vec<PathBuf> = events
                    .into_iter()
                    .map(|e| e.path)
                    .filter(|p| event_matches_target(p, &target))
                    .collect();
                if !matched.is_empty() {
                    let _ = tx.send(matched);
                }
            }
        })
        .unwrap();

        debouncer
            .watcher()
            .watch(dir.path(), RecursiveMode::NonRecursive)
            .unwrap();

        atomic_write(&path, b"v2-atomic").unwrap();

        let matched = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("parent directory watcher should detect atomic replace");
        assert!(!matched.is_empty());
    }

    #[test]
    fn debounced_parent_watcher_coalesces_rapid_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("coalesce.hwp");
        atomic_write(&path, b"v0").unwrap();

        let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
        let target = path.clone();
        let mut debouncer = new_debouncer(Duration::from_millis(150), move |res: DebounceEventResult| {
            if let Ok(events) = res {
                let matched: Vec<PathBuf> = events
                    .into_iter()
                    .map(|e| e.path)
                    .filter(|p| event_matches_target(p, &target))
                    .collect();
                if !matched.is_empty() {
                    let _ = tx.send(matched);
                }
            }
        })
        .unwrap();

        debouncer
            .watcher()
            .watch(dir.path(), RecursiveMode::NonRecursive)
            .unwrap();

        for i in 1..=5 {
            atomic_write(&path, format!("rapid-write-{i}").as_bytes()).unwrap();
            std::thread::sleep(Duration::from_millis(15));
        }

        let first_batch = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("debouncer should emit coalesced batch");
        assert!(!first_batch.is_empty());

        let mut extra_batches = 0;
        while rx.recv_timeout(Duration::from_millis(250)).is_ok() {
            extra_batches += 1;
        }
        assert!(
            extra_batches < 4,
            "expected 5 rapid writes to coalesce, got {} batches",
            1 + extra_batches
        );
    }

    #[test]
    fn manager_ignores_touch_with_same_content_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("touched.hwp");
        atomic_write(&path, b"identical-bytes").unwrap();
        let baseline = file_fingerprint(&path).unwrap();

        let manager = FileWatcherManager::default();
        insert_test_entry(&manager, "doc-touch", path.clone());

        // Touch mtime without changing file content
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(std::time::SystemTime::now() + Duration::from_secs(60))
            .unwrap();
        drop(file);

        assert_eq!(
            manager.evaluate_and_record("doc-touch", &path, Some(&baseline)),
            None
        );
    }

    #[test]
    fn debounced_parent_watcher_and_manager_detect_temp_file_rename_replace() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("renamed.hwp");
        let tmp = dir.path().join("renamed.hwp.mcp.tmp");
        atomic_write(&target, b"before-rename").unwrap();
        let baseline = file_fingerprint(&target).unwrap();

        let manager = FileWatcherManager::default();
        insert_test_entry(&manager, "doc-rename", target.clone());

        let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
        let target_clone = target.clone();
        let mut debouncer = new_debouncer(Duration::from_millis(100), move |res: DebounceEventResult| {
            if let Ok(events) = res {
                let matched: Vec<PathBuf> = events
                    .into_iter()
                    .map(|e| e.path)
                    .filter(|p| event_matches_target(p, &target_clone))
                    .collect();
                if !matched.is_empty() {
                    let _ = tx.send(matched);
                }
            }
        })
        .unwrap();

        debouncer
            .watcher()
            .watch(dir.path(), RecursiveMode::NonRecursive)
            .unwrap();

        std::fs::write(&tmp, b"after-temp-rename").unwrap();
        std::fs::rename(&tmp, &target).unwrap();

        let matched = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("parent watcher should detect temp file + rename");
        assert!(!matched.is_empty());

        let payload = manager
            .evaluate_and_record("doc-rename", &target, Some(&baseline))
            .expect("manager should report modified after rename");
        assert_eq!(payload.kind, ExternalChangeKind::Modified);
    }

    #[test]
    fn debounced_parent_watcher_ignores_unwatched_sibling_files() {
        let dir = tempfile::tempdir().unwrap();
        let watched = dir.path().join("watched.hwp");
        let sibling = dir.path().join("other.hwp");
        let sibling_tmp = dir.path().join("watched.hwp.tmp");
        atomic_write(&watched, b"watched-v1").unwrap();

        let (tx, rx) = mpsc::channel::<Vec<PathBuf>>();
        let watched_clone = watched.clone();
        let mut debouncer = new_debouncer(Duration::from_millis(80), move |res: DebounceEventResult| {
            if let Ok(events) = res {
                let matched: Vec<PathBuf> = events
                    .into_iter()
                    .map(|e| e.path)
                    .filter(|p| event_matches_target(p, &watched_clone))
                    .collect();
                if !matched.is_empty() {
                    let _ = tx.send(matched);
                }
            }
        })
        .unwrap();

        debouncer
            .watcher()
            .watch(dir.path(), RecursiveMode::NonRecursive)
            .unwrap();

        atomic_write(&sibling, b"sibling-content").unwrap();
        std::fs::write(&sibling_tmp, b"tmp-content").unwrap();
        std::fs::remove_file(&sibling).unwrap();

        assert!(
            rx.recv_timeout(Duration::from_millis(300)).is_err(),
            "unrelated sibling files should not trigger watched target"
        );

        let manager = FileWatcherManager::default();
        assert_eq!(
            manager.evaluate_and_record("unwatched-doc", &watched, None),
            None
        );
    }

    #[test]
    fn manager_ignores_self_save_when_baseline_updated_and_detects_subsequent_external_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("self-save.hwp");
        atomic_write(&path, b"v1").unwrap();

        let manager = FileWatcherManager::default();
        insert_test_entry(&manager, "doc-self", path.clone());

        atomic_write(&path, b"v2-by-self").unwrap();
        let updated_baseline = file_fingerprint(&path).unwrap();

        // Self-save is filtered by content comparison against updated source_fingerprint
        assert_eq!(
            manager.evaluate_and_record("doc-self", &path, Some(&updated_baseline)),
            None
        );

        // Immediate external modification after self-save is NOT dropped
        atomic_write(&path, b"v3-by-external").unwrap();
        let payload = manager
            .evaluate_and_record("doc-self", &path, Some(&updated_baseline))
            .expect("external write immediately after self-save should be detected");
        assert_eq!(payload.kind, ExternalChangeKind::Modified);

        // Unknown doc_id calls do not panic
        manager.unwatch("missing-doc");
        manager.unwatch_for_window("missing-window");
    }

    #[test]
    fn manager_is_watching_is_idempotent_for_same_doc_window_and_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("idempotent.hwp");
        let other_path = dir.path().join("other.hwp");
        atomic_write(&path, b"v1").unwrap();
        atomic_write(&other_path, b"v2").unwrap();

        let manager = FileWatcherManager::default();
        insert_test_entry_for_window(&manager, "doc-1", "main", path.clone());

        assert!(manager.is_watching("doc-1", "main", &path).unwrap());
        assert!(!manager.is_watching("doc-1", "main-2", &path).unwrap());
        assert!(!manager.is_watching("doc-1", "main", &other_path).unwrap());
        assert!(!manager.is_watching("doc-2", "main", &path).unwrap());
    }

    #[test]
    fn unwatch_for_window_removes_only_matching_window_entries() {
        let dir = tempfile::tempdir().unwrap();
        let p1 = dir.path().join("a.hwp");
        let p2 = dir.path().join("b.hwp");
        let p3 = dir.path().join("c.hwp");

        let manager = FileWatcherManager::default();
        insert_test_entry_for_window(&manager, "doc-a", "main", p1);
        insert_test_entry_for_window(&manager, "doc-b", "main", p2);
        insert_test_entry_for_window(&manager, "doc-c", "main-2", p3);

        manager.unwatch_for_window("main");

        let watches = manager.watches.lock().unwrap();
        assert!(!watches.contains_key("doc-a"));
        assert!(!watches.contains_key("doc-b"));
        assert!(watches.contains_key("doc-c"));
    }

    #[test]
    fn evaluate_and_record_retries_transient_permission_denied_and_succeeds() {
        let path = PathBuf::from("C:\\docs\\locked.hwp");
        let baseline = make_fp(10, 100, 1);
        let updated = make_fp(12, 200, 2);

        let manager = FileWatcherManager::default();
        insert_test_entry(&manager, "doc-retry", path.clone());

        let mut attempts = 0usize;
        let payload = manager
            .evaluate_and_record_with_reader(
                "doc-retry",
                &path,
                Some(&baseline),
                || {
                    attempts += 1;
                    if attempts < 4 {
                        Err(std::io::Error::new(
                            std::io::ErrorKind::PermissionDenied,
                            "sharing violation",
                        ))
                    } else {
                        Ok(updated.clone())
                    }
                },
                FINGERPRINT_RETRY_MAX_ATTEMPTS,
                Duration::ZERO,
            )
            .expect("should succeed after transient PermissionDenied retries");

        assert_eq!(attempts, 4);
        assert_eq!(payload.kind, ExternalChangeKind::Modified);
        assert_eq!(
            manager.watches.lock().unwrap()["doc-retry"].last_notified,
            Some(NotifiedChange::Modified(updated))
        );
    }

    #[test]
    fn evaluate_and_record_preserves_last_notified_when_retries_exhausted() {
        let path = PathBuf::from("C:\\docs\\still-locked.hwp");
        let baseline = make_fp(10, 100, 1);
        let prev = make_fp(11, 150, 2);
        let next = make_fp(15, 300, 3);

        let manager = FileWatcherManager::default();
        insert_test_entry(&manager, "doc-locked", path.clone());
        manager.watches.lock().unwrap().get_mut("doc-locked").unwrap().last_notified =
            Some(NotifiedChange::Modified(prev.clone()));

        let mut attempts = 0usize;
        let result = manager.evaluate_and_record_with_reader(
            "doc-locked",
            &path,
            Some(&baseline),
            || {
                attempts += 1;
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "sharing violation",
                ))
            },
            FINGERPRINT_RETRY_MAX_ATTEMPTS,
            Duration::ZERO,
        );

        assert_eq!(result, None);
        assert_eq!(attempts, FINGERPRINT_RETRY_MAX_ATTEMPTS);
        assert_eq!(
            manager.watches.lock().unwrap()["doc-locked"].last_notified,
            Some(NotifiedChange::Modified(prev))
        );

        // Once lock clears, the next evaluation detects the new modification
        let payload = manager
            .evaluate_and_record_with_reader(
                "doc-locked",
                &path,
                Some(&baseline),
                || Ok(next.clone()),
                FINGERPRINT_RETRY_MAX_ATTEMPTS,
                Duration::ZERO,
            )
            .expect("should detect change once file becomes readable");
        assert_eq!(payload.kind, ExternalChangeKind::Modified);
    }

    #[test]
    fn manager_acknowledge_change_on_deleted_file_does_not_panic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gone.hwp");
        atomic_write(&path, b"initial").unwrap();
        let baseline = file_fingerprint(&path).unwrap();

        let manager = FileWatcherManager::default();
        insert_test_entry(&manager, "doc-gone", path.clone());

        std::fs::remove_file(&path).unwrap();
        manager.acknowledge_change("doc-gone").unwrap();

        assert_eq!(
            manager.evaluate_and_record("doc-gone", &path, Some(&baseline)),
            None
        );
    }
}
