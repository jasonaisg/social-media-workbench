package services

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"wx_channel/internal/database"
	"wx_channel/internal/database/model"
)

func TestDownloadedContentStatusChecksOnlyRequestedArchives(t *testing.T) {
	root := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(root, "status.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.DownloadResource{}, &model.ContentRelation{}); err != nil {
		t.Fatal(err)
	}
	write := func(content_id, name string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte("done"), 0600); err != nil {
			t.Fatal(err)
		}
		resource := model.DownloadResource{ContentId: &content_id, DownloadDir: root, Name: name, Kind: "text/html", Size: 99, Status: 2}
		if err := db.Create(&resource).Error; err != nil {
			t.Fatal(err)
		}
	}
	write("wxmp:direct", "direct.html")
	write("wxmp:child", "child.html")
	if err := db.Create(&model.ContentRelation{SourceContentId: "wxmp:parent", TargetContentId: "wxmp:child", Type: model.ContentRelationContains}).Error; err != nil {
		t.Fatal(err)
	}
	status, err := DownloadedContentStatus(db, []string{"wxmp:direct", "wxmp:parent", "wxmp:missing", "wxmp:direct"})
	if err != nil {
		t.Fatal(err)
	}
	if !status["wxmp:direct"] || !status["wxmp:parent"] || status["wxmp:missing"] || len(status) != 3 {
		t.Fatalf("unexpected status: %#v", status)
	}
}

func TestDownloadedLibraryFiltersFilesAndKeepsDeletedQueue(t *testing.T) {
	root := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(root, "test.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"000001_init.up.sql", "000002_content_media_asset.up.sql"} {
		sql, err := database.Migrations.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if err = db.Exec(string(sql)).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"article", "video", "missing", "partial", "pending"} {
		kind := "video"
		if id == "article" {
			kind = "article"
		}
		content := model.Content{Id: id, PlatformId: "wxmp", ExternalId: id, Type: kind, Title: id, Tags: `["AI"]`, Metadata: `{"wxchannels_metrics":{"counts":{"favCount":0,"likeCount":23},"fetched_at":123},"unrelated":"keep-private"}`}
		if err = db.Create(&content).Error; err != nil {
			t.Fatal(err)
		}
		account := model.Account{Id: id, PlatformId: "wxmp", ExternalId: id, Nickname: id}
		if err = db.Create(&account).Error; err != nil {
			t.Fatal(err)
		}
		if err = db.Exec("INSERT INTO content_account (content_id, account_id) VALUES (?, ?)", id, id).Error; err != nil {
			t.Fatal(err)
		}
		filename := id
		if id == "article" {
			filename = id + ".html"
		}
		if id != "missing" {
			if err = os.WriteFile(filepath.Join(root, filename), []byte("file"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		size, status := int64(4), 2
		resource_kind := "file"
		var deleted_at *int64
		if id == "article" {
			// Rendered articles change size after post-processing and the queue
			// record may already have been cleared; the archive still exists.
			size = 99
			resource_kind = "text/html"
			value := int64(456)
			deleted_at = &value
		}
		if id == "partial" {
			size = 10
		}
		if id == "pending" {
			status = 1
		}
		r := model.DownloadResource{ContentId: &id, DownloadDir: root, Name: filename, Kind: resource_kind, Size: size, Status: status, Timestamps: model.Timestamps{DeletedAt: deleted_at}}
		if err = db.Create(&r).Error; err != nil {
			t.Fatal(err)
		}
	}
	// No live queue records exist, but archived files must still be listed.
	accounts, err := NewAccountService(db).ListAccounts(context.Background(), AccountListInput{DownloadedOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if accounts.Total != 2 {
		t.Fatalf("accounts = %+v", accounts)
	}
	for _, account := range accounts.List {
		if account.ContentCount != 1 {
			t.Fatalf("count = %+v", account)
		}
	}
	s := NewContentService(db)
	page, err := s.ListContents(ContentListOptions{Scope: ContentListScopeDownloaded, PageSize: 1, Page: 1})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || len(page.List) != 1 {
		t.Fatalf("page = %+v", page)
	}
	article, err := s.ListContents(ContentListOptions{Scope: ContentListScopeDownloaded, AccountID: "article"})
	if err != nil {
		t.Fatal(err)
	}
	if article.Total != 1 || article.List[0].Type != "article" {
		t.Fatalf("article = %+v", article)
	}
	if article.List[0].FileCount != 1 {
		t.Fatalf("article file count = %d", article.List[0].FileCount)
	}
	if article.List[0].Tags != `["AI"]` {
		t.Fatalf("article tags = %s", article.List[0].Tags)
	}
	if string(article.List[0].InteractionMetrics) != `{"counts":{"favCount":0,"likeCount":23},"fetched_at":123}` {
		t.Fatalf("list lost saved metrics: %s", article.List[0].InteractionMetrics)
	}
	detail, err := s.GetContentDetail("article")
	if err != nil {
		t.Fatal(err)
	}
	if string(detail.InteractionMetrics) != string(article.List[0].InteractionMetrics) {
		t.Fatal("detail and list metrics differ")
	}
	if detail.Tags != article.List[0].Tags {
		t.Fatal("detail and list tags differ")
	}
	// An old task without counters should recover the persisted archive snapshot on reload.
	contentID := "video"
	task := model.DownloadTask{ContentId: &contentID, PlatformId: "wxchannels", UniqueID: "metrics-reload", Timestamps: model.Timestamps{CreatedAt: 123, UpdatedAt: 123}, MetadataJSON: `{"other":"preserved"}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	var reloaded model.DownloadTask
	if err := db.First(&reloaded, task.Id).Error; err != nil {
		t.Fatal(err)
	}
	records, err := (&DownloadTaskService{db: db}).BuildTaskRecords([]model.DownloadTask{reloaded})
	if err != nil {
		t.Fatal(err)
	}
	var shown map[string]json.RawMessage
	if err := json.Unmarshal([]byte(records[0].MetadataJSON), &shown); err != nil {
		t.Fatal(err)
	}
	if string(shown["wxchannels_metrics"]) != string(detail.InteractionMetrics) || string(shown["other"]) != `"preserved"` {
		t.Fatalf("task lost archive counters: %s", records[0].MetadataJSON)
	}
	archive := model.Content{Id: "wxchannels:history-video", PlatformId: "wxchannels", ExternalId: "history-video", Type: "video", Metadata: `{"wxchannels_metrics":{"counts":{"favCount":0,"forwardCount":42},"fetched_at":123}}`}
	if err := db.Create(&archive).Error; err != nil {
		t.Fatal(err)
	}
	history := model.BrowseHistory{Id: "history-row", PlatformId: "wxchannels", ExternalId: "history-video", Type: "video"}
	if err := db.Create(&history).Error; err != nil {
		t.Fatal(err)
	}
	browsed, err := (&BrowseService{db: db}).List("wxchannels", nil, 1, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(browsed.List) != 1 || string(browsed.List[0].InteractionMetrics) != string(contentInteractionMetrics(archive.Metadata)) {
		t.Fatalf("browse lost archive metrics: %+v", browsed)
	}
	if err = os.Remove(filepath.Join(root, "article.html")); err != nil {
		t.Fatal(err)
	}
	article, err = s.ListContents(ContentListOptions{Scope: ContentListScopeDownloaded, AccountID: "article"})
	if err != nil || article.Total != 0 {
		t.Fatalf("missing article: %+v %v", article, err)
	}
}
