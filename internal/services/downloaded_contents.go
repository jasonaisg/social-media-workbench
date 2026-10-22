package services

import (
	"os"
	"path/filepath"
	"strings"

	"gorm.io/gorm"
	"wx_channel/internal/database/model"
)

// downloaded_content_file_paths resolves the local archive itself, rather than
// the live queue row. Historical task/resource rows remain useful after the
// queue is cleared, while missing, unfinished and partial files are excluded.
func downloaded_content_file_paths(db *gorm.DB, content_ids []string) (map[string]map[string]struct{}, error) {
	var resources []model.DownloadResource
	query := db.Unscoped().Where("status = ? AND content_id <> ''", 2)
	if content_ids != nil {
		if len(content_ids) == 0 {
			return map[string]map[string]struct{}{}, nil
		}
		query = query.Where("content_id IN ?", content_ids)
	}
	if err := query.Find(&resources).Error; err != nil {
		return nil, err
	}
	files := make(map[string]map[string]struct{})
	for _, resource := range resources {
		if resource.ContentId == nil || strings.TrimSpace(*resource.ContentId) == "" {
			continue
		}
		path := filepath.Clean(filepath.Join(resource.DownloadDir, resource.Name))
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
			continue
		}
		// Rendered HTML archives are post-processed after download, so their
		// final byte size legitimately differs from the HTTP response size.
		kind := strings.ToLower(strings.TrimSpace(resource.Kind))
		is_html := kind == "html" || kind == "text/html" || strings.EqualFold(filepath.Ext(resource.Name), ".html")
		if resource.Size > 0 && info.Size() != resource.Size && !is_html {
			continue
		}
		content_id := strings.TrimSpace(*resource.ContentId)
		if files[content_id] == nil {
			files[content_id] = make(map[string]struct{})
		}
		files[content_id][path] = struct{}{}
	}
	return files, nil
}

// DownloadedContentIDs uses archive resources, not queue records: deleting a
// task must not hide its files. Missing or partial files are not local content.
func DownloadedContentIDs(db *gorm.DB) ([]string, error) {
	files, err := downloaded_content_file_paths(db, nil)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(files))
	ids := make([]string, 0, len(files))
	for content_id := range files {
		seen[content_id] = struct{}{}
		ids = append(ids, content_id)
	}

	// Collections and articles can own embedded media resources. Their parent
	// item is downloaded whenever at least one contained child has a local file.
	if len(ids) > 0 {
		var parent_ids []string
		if err := db.Table("content_relation").
			Distinct("source_content_id").
			Where("type = ? AND target_content_id IN ?", model.ContentRelationContains, ids).
			Pluck("source_content_id", &parent_ids).Error; err != nil {
			return nil, err
		}
		for _, parent_id := range parent_ids {
			parent_id = strings.TrimSpace(parent_id)
			if parent_id == "" {
				continue
			}
			if _, exists := seen[parent_id]; exists {
				continue
			}
			seen[parent_id] = struct{}{}
			ids = append(ids, parent_id)
		}
	}
	return ids, nil
}

// DownloadedContentStatus checks a bounded set of content IDs against real
// complete files on disk. It preserves the same parent/embedded-content
// semantics as DownloadedContentIDs without scanning every archived resource.
func DownloadedContentStatus(db *gorm.DB, content_ids []string) (map[string]bool, error) {
	status := make(map[string]bool, len(content_ids))
	requested := make([]string, 0, len(content_ids))
	seen := make(map[string]struct{}, len(content_ids))
	for _, content_id := range content_ids {
		content_id = strings.TrimSpace(content_id)
		if content_id == "" {
			continue
		}
		status[content_id] = false
		if _, exists := seen[content_id]; exists {
			continue
		}
		seen[content_id] = struct{}{}
		requested = append(requested, content_id)
	}
	if len(requested) == 0 {
		return status, nil
	}

	direct_files, err := downloaded_content_file_paths(db, requested)
	if err != nil {
		return nil, err
	}
	for content_id := range direct_files {
		status[content_id] = true
	}

	var relations []model.ContentRelation
	if err := db.Select("source_content_id", "target_content_id").
		Where("type = ? AND source_content_id IN ?", model.ContentRelationContains, requested).
		Find(&relations).Error; err != nil {
		return nil, err
	}
	if len(relations) == 0 {
		return status, nil
	}
	target_ids := make([]string, 0, len(relations))
	for _, relation := range relations {
		target_ids = append(target_ids, relation.TargetContentId)
	}
	embedded_files, err := downloaded_content_file_paths(db, target_ids)
	if err != nil {
		return nil, err
	}
	for _, relation := range relations {
		if len(embedded_files[relation.TargetContentId]) > 0 {
			status[relation.SourceContentId] = true
		}
	}
	return status, nil
}

func downloaded_content_file_counts(db *gorm.DB, content_ids []string) (map[string]int64, error) {
	files, err := downloaded_content_file_paths(db, content_ids)
	if err != nil {
		return nil, err
	}
	counts := make(map[string]int64, len(files))
	for content_id, paths := range files {
		counts[content_id] = int64(len(paths))
	}
	return counts, nil
}
