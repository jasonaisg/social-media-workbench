package services

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"wx_channel/internal/database"
	"wx_channel/internal/database/model"
)

func TestDeleteDownloadedContentFilesRemovesHistoricalArchiveButKeepsContent(t *testing.T) {
	root := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(root, "test.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"000001_init.up.sql", "000002_content_media_asset.up.sql"} {
		sql, read_err := database.Migrations.ReadFile("migrations/" + name)
		if read_err != nil {
			t.Fatal(read_err)
		}
		if err = db.Exec(string(sql)).Error; err != nil {
			t.Fatal(err)
		}
	}

	content_id := "wxmp:delete-local"
	if err = db.Create(&model.Content{
		Id: content_id, PlatformId: "wxmp", ExternalId: "delete-local", Type: "article", Title: "keep metadata",
	}).Error; err != nil {
		t.Fatal(err)
	}
	deleted_at := int64(100)
	task := model.DownloadTask{
		ContentId: &content_id, PlatformId: "wxmp", Name: "archive", UniqueID: "delete-local", Status: model.TaskStatusFinished,
		Timestamps: model.Timestamps{CreatedAt: 1, UpdatedAt: 1, DeletedAt: &deleted_at},
	}
	if err = db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	archive_path := filepath.Join(root, "archive.html")
	if err = os.WriteFile(archive_path, []byte("<main id=\"js_content\">saved</main>"), 0600); err != nil {
		t.Fatal(err)
	}
	resource := model.DownloadResource{
		TaskId: &task.Id, ContentId: &content_id, DownloadDir: root, Name: filepath.Base(archive_path), Kind: "text/html",
		Size: 8, Status: 2, Timestamps: model.Timestamps{DeletedAt: &deleted_at},
	}
	if err = db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}

	service := NewDownloadTaskService(db, nil, nil, nil, root, root, nil)
	if err = service.DeleteDownloadedContentFiles(content_id); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(archive_path); !os.IsNotExist(err) {
		t.Fatalf("archive still exists: %v", err)
	}
	var content model.Content
	if err = db.First(&content, "id = ?", content_id).Error; err != nil {
		t.Fatalf("content metadata was removed: %v", err)
	}
	ids, err := DownloadedContentIDs(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 0 {
		t.Fatalf("deleted archive still listed: %v", ids)
	}
}
