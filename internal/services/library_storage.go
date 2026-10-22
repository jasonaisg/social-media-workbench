package services

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"
	"wx_channel/internal/adapter"
	"wx_channel/internal/database/model"
	"wx_channel/pkg/hermes"
	"wx_channel/pkg/librarypath"
)

// Serialize identity lookup and task persistence, including requests from Get and Channels.
var libraryCreateMu sync.Mutex

// Retrying a historical queue item must not bypass the archive's identity rules.
func (s *DownloadTaskService) libraryResumeGuard(task *model.DownloadTask) error {
	if !s.managedLibrary() {
		return nil
	}
	var resources []model.DownloadResource
	if err := s.db.Where("task_id = ?", task.Id).Find(&resources).Error; err != nil {
		return err
	}
	for _, resource := range resources {
		var active int64
		if err := s.db.Table("download_resource r").Joins("JOIN download_task t ON t.id = r.task_id").Where("t.id <> ? AND t.platform_id = ? AND r.unique_id = ? AND t.deleted_at IS NULL AND t.status IN (0,1,2,3,4)", task.Id, task.PlatformId, resource.UniqueID).Count(&active).Error; err != nil {
			return err
		}
		if active > 0 {
			return fmt.Errorf("相同清晰度已有下载任务，请查看下载队列")
		}
		var archived []model.DownloadResource
		if err := s.db.Unscoped().Table("download_resource r").Select("r.*").Joins("JOIN download_task t ON t.id = r.task_id").Where("t.platform_id = ? AND r.unique_id = ?", task.PlatformId, resource.UniqueID).Scan(&archived).Error; err != nil {
			return err
		}
		for _, previous := range archived {
			// A failed wxmp retry may leave its own post-processed temporary
			// output behind. That file must not make the task permanently
			// un-retryable. Other platforms retain the original conservative
			// guard because their partial files are not structurally verifiable.
			if task.PlatformId == "wxmp" && previous.TaskId != nil && *previous.TaskId == task.Id {
				continue
			}
			archive_path := filepath.Join(previous.DownloadDir, previous.Name)
			st, stat_err := os.Stat(archive_path)
			if stat_err == nil && st.Mode().IsRegular() && st.Size() > 0 {
				if task.PlatformId == "wxmp" && !reusable_wxmp_archive(archive_path) {
					continue
				}
				return fmt.Errorf("此任务已有归档文件，已阻止重复下载；如需补齐缺失文件，请从 Get 或视频号重新添加，系统会跳过已完成的资源")
			}
		}
	}
	return nil
}

// reconcileArchivedWXMPTask converts a failed legacy wxmp queue item into a
// completed task when its verified canonical article archive already exists.
// Older builds stored Kind="html" and an extensionless Name, so retrying could
// fully render the article and still fail final validation at the .html rename.
func (s *DownloadTaskService) reconcileArchivedWXMPTask(task *model.DownloadTask) (bool, error) {
	if task == nil || task.PlatformId != "wxmp" || !s.managedLibrary() {
		return false, nil
	}

	var resources []model.DownloadResource
	if err := s.db.Where("task_id = ?", task.Id).Find(&resources).Error; err != nil {
		return false, err
	}
	if len(resources) != 1 || !is_wxmp_html_resource(resources[0]) {
		return false, nil
	}

	resource := resources[0]
	expected_name := librarypath.ID(resource.UniqueID) + ".html"
	candidates := []string{filepath.Join(resource.DownloadDir, expected_name)}
	var archived []model.DownloadResource
	if err := s.db.Unscoped().Table("download_resource r").Select("r.*").
		Joins("JOIN download_task t ON t.id = r.task_id").
		Where("t.platform_id = ? AND r.unique_id = ?", task.PlatformId, resource.UniqueID).
		Order("r.id ASC").
		Scan(&archived).Error; err != nil {
		return false, err
	}
	for _, previous := range archived {
		if filepath.Base(previous.Name) == expected_name {
			candidates = append(candidates, filepath.Join(previous.DownloadDir, previous.Name))
		}
	}

	archive_path := ""
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		candidate = filepath.Clean(candidate)
		if _, exists := seen[candidate]; exists || !download_task_path_within_root(s.work_dir, candidate) {
			continue
		}
		seen[candidate] = struct{}{}
		if reusable_wxmp_archive(candidate) {
			archive_path = candidate
			break
		}
	}
	if archive_path == "" {
		// A legacy retry can itself have produced a complete extensionless
		// article. Canonicalize it only when the .html destination is free.
		legacy_path := filepath.Join(resource.DownloadDir, resource.Name)
		canonical_path := filepath.Join(resource.DownloadDir, expected_name)
		if download_task_path_within_root(s.work_dir, legacy_path) && reusable_wxmp_archive(legacy_path) {
			if _, err := os.Lstat(canonical_path); os.IsNotExist(err) {
				if err := os.Rename(legacy_path, canonical_path); err != nil {
					return false, fmt.Errorf("规范旧公众号归档文件名失败: %w", err)
				}
				archive_path = canonical_path
			} else if err != nil {
				return false, err
			}
		}
	}
	if archive_path == "" {
		return false, nil
	}

	file_info, err := os.Stat(archive_path)
	if err != nil {
		return false, err
	}
	now := time.Now().UnixMilli()
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.DownloadResource{}).Where("id = ?", resource.Id).Updates(map[string]any{
			"download_dir": filepath.Dir(archive_path),
			"name":         filepath.Base(archive_path),
			"kind":         "text/html",
			"size":         file_info.Size(),
			"downloaded":   file_info.Size(),
			"speed":        0,
			"status":       2,
			"finish_time":  now,
			"updated_at":   now,
		}).Error; err != nil {
			return err
		}
		return tx.Model(&model.DownloadTask{}).Where("id = ?", task.Id).Updates(map[string]any{
			"status":        model.TaskStatusFinished,
			"error_message": "",
			"updated_at":    now,
		}).Error
	}); err != nil {
		return false, err
	}
	task.Status = model.TaskStatusFinished
	task.ErrorMessage = ""
	task.UpdatedAt = now
	s.publish_download_task_created(task.Id)
	return true, nil
}

func (s *DownloadTaskService) normalizeLegacyWXMPResources(task *model.DownloadTask) error {
	if task == nil || task.PlatformId != "wxmp" {
		return nil
	}
	var resources []model.DownloadResource
	if err := s.db.Where("task_id = ?", task.Id).Find(&resources).Error; err != nil {
		return err
	}
	for _, resource := range resources {
		if !is_wxmp_html_resource(resource) {
			continue
		}
		expected_name := librarypath.ID(resource.UniqueID) + ".html"
		if resource.Kind == "text/html" && resource.Name == expected_name {
			continue
		}
		if err := s.db.Model(&model.DownloadResource{}).Where("id = ?", resource.Id).Updates(map[string]any{
			"kind":       "text/html",
			"name":       expected_name,
			"updated_at": time.Now().UnixMilli(),
		}).Error; err != nil {
			return err
		}
	}
	return nil
}

func is_wxmp_html_resource(resource model.DownloadResource) bool {
	kind := strings.ToLower(strings.TrimSpace(resource.Kind))
	return kind == "html" || kind == "text/html" || strings.HasSuffix(strings.ToLower(resource.UniqueID), "_html")
}

func (s *DownloadTaskService) managedLibrary() bool {
	_, err := os.Stat(filepath.Join(s.work_dir, "master.json"))
	return err == nil
}

func (s *DownloadTaskService) libraryPlan(info *adapter.DownloadTaskResult, persist bool) (string, error) {
	if info == nil || info.Task == nil {
		return "", fmt.Errorf("缺少下载任务")
	}
	platform, contentID, contentType := info.Task.PlatformId, info.Task.UniqueID, "other"
	if info.Content != nil {
		platform, contentID, contentType = info.Content.PlatformId, info.Content.ExternalId, info.Content.Type
	}
	accountID, nickname := platform+":unknown", "unknown"
	if info.Account != nil && info.Account.Id != "" {
		accountID, nickname = info.Account.Id, info.Account.Nickname
	}
	folder := librarypath.Account(accountID, nickname)
	// A nickname change must not move an existing account's directory.
	if s.db != nil && s.db.Migrator().HasTable("library_account") {
		var saved struct{ Folder string }
		if err := s.db.Table("library_account").Where("id = ?", accountID).Take(&saved).Error; err == nil {
			folder = saved.Folder
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return "", err
		}
	}
	if persist {
		if err := s.db.Exec("CREATE TABLE IF NOT EXISTS library_account (id TEXT PRIMARY KEY, folder TEXT NOT NULL)").Error; err != nil {
			return "", err
		}
		if err := s.db.Exec("INSERT OR IGNORE INTO library_account(id,folder) VALUES (?,?)", accountID, folder).Error; err != nil {
			return "", err
		}
	}
	// Extracted audio is an audio asset even if the platform's parent content is video.
	if len(info.Resources) == 1 && hermes.CanonicalExtensionForMIMEType(info.Resources[0].Resource.Kind) == ".mp3" {
		contentType = "audio"
	}
	if filepath.Base(folder) != folder || folder == "." || folder == ".." {
		return "", fmt.Errorf("非法账号目录")
	}
	dir := filepath.Join(s.work_dir, librarypath.Directory(platform, folder, contentType, contentID))
	cfg := map[string]any{}
	if err := json.Unmarshal([]byte(info.Task.ConfigJSON), &cfg); err != nil && info.Task.ConfigJSON != "" {
		return "", err
	}
	cfg["library_managed"] = true
	cfg["download_dir"] = dir
	encoded, _ := json.Marshal(cfg)
	info.Task.ConfigJSON = string(encoded)
	for _, ri := range info.Resources {
		if ri.Resource.UniqueID == "" {
			return "", fmt.Errorf("资源缺少稳定 ID，不能归档")
		}
		ri.Resource.Name = librarypath.ID(ri.Resource.UniqueID)
		ri.Resource.DownloadDir = dir
	}
	return dir, nil
}

// Reuse files even after queue deletion. Missing files and failed tasks do not block retry.
// Resource identity already contains the platform variant spec/codec and format.
func (s *DownloadTaskService) libraryDeduplicate(info *adapter.DownloadTaskResult, dir string) error {
	retained := make([]*adapter.ResourceInfo, 0, len(info.Resources))
	existingID := 0
	for _, incoming := range info.Resources {
		expected_name := librarypath.ID(incoming.Resource.UniqueID) + hermes.CanonicalExtensionForMIMEType(incoming.Resource.Kind)
		var rows []struct {
			model.DownloadResource
			TaskStatus  int
			TaskDeleted *int64
		}
		err := s.db.Unscoped().Table("download_resource AS r").Select("r.*, t.status AS task_status, t.deleted_at AS task_deleted").
			Joins("JOIN download_task t ON t.id = r.task_id").Where("t.platform_id = ? AND r.unique_id = ?", info.Task.PlatformId, incoming.Resource.UniqueID).Scan(&rows).Error
		if err != nil {
			return err
		}
		found := false
		for _, row := range rows {
			if row.TaskId != nil {
				existingID = *row.TaskId
			}
			if row.TaskDeleted == nil && !is_terminal_download_task_status(row.TaskStatus) {
				return &DuplicateTaskError{ExistingTaskID: existingID, ExistingTaskName: info.Task.Name, IncomingUniqueID: info.Task.UniqueID, LibraryReuse: true}
			}
			archive_path := filepath.Join(row.DownloadDir, row.Name)
			st, err := os.Stat(archive_path)
			if err == nil && st.Mode().IsRegular() && st.Size() > 0 && row.Name == expected_name {
				if row.Status == 2 && (row.Size <= 0 || st.Size() == row.Size) {
					found = true
					break
				}
				// A wxmp article is rewritten after transfer so its final size can
				// legitimately differ from the source response. Queue deletion and
				// historical post-processing failures must not erase the archive's
				// stable identity. Reuse only a recognizable workbench-rendered
				// article; arbitrary or partial HTML remains protected below.
				if info.Task.PlatformId == "wxmp" && reusable_wxmp_archive(archive_path) {
					found = true
					break
				}
			}
			if err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		if !found {
			if _, err := os.Lstat(filepath.Join(dir, expected_name)); err == nil {
				return fmt.Errorf("目标已有未核实文件，保留原文件：%s", expected_name)
			} else if !os.IsNotExist(err) {
				return err
			}
			retained = append(retained, incoming)
		}
	}
	if len(retained) == 0 {
		return &DuplicateTaskError{ExistingTaskID: existingID, ExistingTaskName: info.Task.Name, IncomingUniqueID: info.Task.UniqueID, LibraryReuse: true}
	}
	info.Resources = retained
	return nil
}

func reusable_wxmp_archive(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()

	// The workbench wrapper and article container are both emitted before the
	// body, so a bounded read avoids loading base64-heavy articles into memory.
	buffer := make([]byte, 256*1024)
	n, _ := file.Read(buffer)
	if n == 0 {
		return false
	}
	head := string(buffer[:n])
	return strings.Contains(head, `class="wxmp-article-shell"`) &&
		strings.Contains(head, `id="js_content"`) &&
		strings.Contains(head, `rich_media_content`)
}
