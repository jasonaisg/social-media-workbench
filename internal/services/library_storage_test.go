package services

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"wx_channel/internal/adapter"
	"wx_channel/internal/database/model"
)

func libraryTestService(t *testing.T) *DownloadTaskService {
	t.Helper()
	root := t.TempDir()
	db, err := gorm.Open(sqlite.Open(filepath.Join(root, "test.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(&model.DownloadTask{}, &model.DownloadResource{}); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(root, "master.json"), []byte(`{"layout_version":1}`), 0600)
	return NewDownloadTaskService(db, nil, nil, nil, root, filepath.Join(root, "library"), nil)
}
func libraryInfo(spec string) *adapter.DownloadTaskResult {
	id := "123" + spec
	return &adapter.DownloadTaskResult{Task: &model.DownloadTask{UniqueID: id, PlatformId: "wxchannels", Name: "很长的标题", ConfigJSON: "{}"}, Content: &model.Content{Id: "wxchannels:123", PlatformId: "wxchannels", ExternalId: "123", Type: "video"}, Account: &model.Account{Id: "wxchannels:author", Nickname: "测试账号"}, Resources: []*adapter.ResourceInfo{{Resource: model.DownloadResource{UniqueID: id, Kind: "video/mp4"}}}}
}
func TestLibraryStablePathAcrossRenameAndVariant(t *testing.T) {
	s := libraryTestService(t)
	a := libraryInfo("_720p")
	dir, err := s.libraryPlan(a, true)
	if err != nil {
		t.Fatal(err)
	}
	b := libraryInfo("_1080p")
	b.Account.Nickname = "账号改名"
	b.Task.Name = "标题改名"
	second, err := s.libraryPlan(b, true)
	if err != nil {
		t.Fatal(err)
	}
	if dir != second || a.Resources[0].Resource.Name == b.Resources[0].Resource.Name {
		t.Fatal("identity or variant lost")
	}
	if filepath.Base(dir) != "videos" {
		t.Fatal(dir)
	}
}
func TestLibraryReuseDeletedQueueAndMissingFile(t *testing.T) {
	s := libraryTestService(t)
	a := libraryInfo("_720p")
	dir, err := s.libraryPlan(a, true)
	if err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(dir, 0755)
	path := filepath.Join(dir, "123_720p.mp4")
	os.WriteFile(path, []byte("video"), 0600)
	deleted := int64(2)
	task := model.DownloadTask{Id: 1, Name: "old", PlatformId: "wxchannels", Status: 5, Timestamps: model.Timestamps{CreatedAt: 1, DeletedAt: &deleted}}
	if err := s.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	r := model.DownloadResource{TaskId: &task.Id, UniqueID: "123_720p", Name: "123_720p.mp4", DownloadDir: dir, Size: 5, Status: 2}
	if err := s.db.Create(&r).Error; err != nil {
		t.Fatal(err)
	}
	var duplicate *DuplicateTaskError
	if err := s.libraryDeduplicate(a, dir); !errors.As(err, &duplicate) || !duplicate.LibraryReuse {
		t.Fatalf("not reused: %v", err)
	}
	if err := s.libraryDeduplicate(libraryInfo("_1080p"), dir); err != nil {
		t.Fatalf("different variant blocked: %v", err)
	}
	os.Remove(path)
	if err := s.libraryDeduplicate(libraryInfo("_720p"), dir); err != nil {
		t.Fatalf("missing file blocked: %v", err)
	}
}

func TestLibraryReusesRenderedWXMPArchiveAfterQueueDeletion(t *testing.T) {
	s := libraryTestService(t)
	info := &adapter.DownloadTaskResult{
		Task:    &model.DownloadTask{UniqueID: "article-1", PlatformId: "wxmp", Name: "文章", ConfigJSON: "{}"},
		Content: &model.Content{Id: "wxmp:article-1", PlatformId: "wxmp", ExternalId: "article-1", Type: "article"},
		Account: &model.Account{Id: "wxmp:author", Nickname: "测试公众号"},
		Resources: []*adapter.ResourceInfo{{Resource: model.DownloadResource{
			UniqueID: "article-1_html",
			Kind:     "text/html",
		}}},
	}
	dir, err := s.libraryPlan(info, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	name := "article-1_html.html"
	path := filepath.Join(dir, name)
	finalHTML := `<!doctype html><html><body><main class="wxmp-article-shell"><div id="js_content" class="rich_media_content">正文</div></main></body></html>`
	if err := os.WriteFile(path, []byte(finalHTML), 0600); err != nil {
		t.Fatal(err)
	}
	deleted := int64(2)
	task := model.DownloadTask{Id: 1, Name: "old", PlatformId: "wxmp", Status: 6, Timestamps: model.Timestamps{CreatedAt: 1, DeletedAt: &deleted}}
	if err := s.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	resource := model.DownloadResource{
		TaskId: &task.Id, UniqueID: "article-1_html", Name: name,
		Kind: "text/html", DownloadDir: dir, Size: 12, Status: 3,
	}
	if err := s.db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}

	var duplicate *DuplicateTaskError
	if err := s.libraryDeduplicate(info, dir); !errors.As(err, &duplicate) || !duplicate.LibraryReuse {
		t.Fatalf("rendered wxmp archive was not reused: %v", err)
	}
}

func TestLibraryRejectsUnverifiedWXMPArchiveAfterQueueDeletion(t *testing.T) {
	s := libraryTestService(t)
	info := &adapter.DownloadTaskResult{
		Task:    &model.DownloadTask{UniqueID: "article-2", PlatformId: "wxmp", Name: "文章", ConfigJSON: "{}"},
		Content: &model.Content{Id: "wxmp:article-2", PlatformId: "wxmp", ExternalId: "article-2", Type: "article"},
		Account: &model.Account{Id: "wxmp:author", Nickname: "测试公众号"},
		Resources: []*adapter.ResourceInfo{{Resource: model.DownloadResource{
			UniqueID: "article-2_html",
			Kind:     "text/html",
		}}},
	}
	dir, err := s.libraryPlan(info, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	name := "article-2_html.html"
	if err := os.WriteFile(filepath.Join(dir, name), []byte("partial response"), 0600); err != nil {
		t.Fatal(err)
	}
	deleted := int64(2)
	task := model.DownloadTask{Id: 2, Name: "old", PlatformId: "wxmp", Status: 6, Timestamps: model.Timestamps{CreatedAt: 1, DeletedAt: &deleted}}
	if err := s.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	resource := model.DownloadResource{
		TaskId: &task.Id, UniqueID: "article-2_html", Name: name,
		Kind: "text/html", DownloadDir: dir, Size: 12, Status: 3,
	}
	if err := s.db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}

	if err := s.libraryDeduplicate(info, dir); err == nil {
		t.Fatal("unverified wxmp archive would have been reused or overwritten")
	}
}
func TestLibraryRejectUnknownExistingFile(t *testing.T) {
	s := libraryTestService(t)
	a := libraryInfo("_720p")
	dir, err := s.libraryPlan(a, true)
	if err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(dir, 0755)
	os.WriteFile(filepath.Join(dir, "123_720p.mp4"), []byte("unknown"), 0600)
	if err := s.libraryDeduplicate(a, dir); err == nil {
		t.Fatal("unknown file would be overwritten")
	}
}

func TestLibraryRetryCannotRedownloadArchivedVariant(t *testing.T) {
	s := libraryTestService(t)
	task := model.DownloadTask{Id: 1, PlatformId: "wxchannels", Status: 6, Timestamps: model.Timestamps{CreatedAt: 1}}
	if err := s.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	r := model.DownloadResource{TaskId: &task.Id, UniqueID: "123_720p", DownloadDir: s.work_dir, Name: "123_720p.mp4", Status: 2}
	if err := s.db.Create(&r).Error; err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(s.work_dir, r.Name), []byte("video"), 0600)
	if err := s.libraryResumeGuard(&task); err == nil {
		t.Fatal("retry bypassed deduplication")
	}
	os.Remove(filepath.Join(s.work_dir, r.Name))
	if err := s.libraryResumeGuard(&task); err != nil {
		t.Fatal(err)
	}
}

func TestLibraryRetryReconcilesLegacyWXMPArchive(t *testing.T) {
	s := libraryTestService(t)
	dir := filepath.Join(s.work_dir, "library", "wxmp", "account", "articles", "article")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	finalHTML := `<!doctype html><html><body><main class="wxmp-article-shell"><div id="js_content" class="rich_media_content">正文</div></main></body></html>`
	canonicalName := "article-legacy_html.html"
	if err := os.WriteFile(filepath.Join(dir, canonicalName), []byte(finalHTML), 0600); err != nil {
		t.Fatal(err)
	}

	deleted := int64(2)
	historical := model.DownloadTask{Id: 1, Name: "old", PlatformId: "wxmp", Status: model.TaskStatusFailed, Timestamps: model.Timestamps{CreatedAt: 1, DeletedAt: &deleted}}
	if err := s.db.Create(&historical).Error; err != nil {
		t.Fatal(err)
	}
	historicalResource := model.DownloadResource{TaskId: &historical.Id, UniqueID: "article-legacy_html", Name: canonicalName, Kind: "text/html", DownloadDir: dir, Status: 3, Timestamps: model.Timestamps{DeletedAt: &deleted}}
	if err := s.db.Create(&historicalResource).Error; err != nil {
		t.Fatal(err)
	}

	current := model.DownloadTask{Id: 2, Name: "retry", PlatformId: "wxmp", Status: model.TaskStatusFailed, ErrorMessage: "归档文件未完成", Timestamps: model.Timestamps{CreatedAt: 2}}
	if err := s.db.Create(&current).Error; err != nil {
		t.Fatal(err)
	}
	currentResource := model.DownloadResource{TaskId: &current.Id, UniqueID: "article-legacy_html", Name: "article-legacy_html", Kind: "html", DownloadDir: dir, Size: 10, Downloaded: 10, Status: 3}
	if err := s.db.Create(&currentResource).Error; err != nil {
		t.Fatal(err)
	}

	retried, err := s.RetryTask(current.Id)
	if err != nil {
		t.Fatal(err)
	}
	if retried.Status != model.TaskStatusFinished || retried.ErrorMessage != "" {
		t.Fatalf("task was not reconciled: %+v", retried)
	}
	var stored model.DownloadResource
	if err := s.db.First(&stored, currentResource.Id).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Kind != "text/html" || stored.Name != canonicalName || stored.Status != 2 || stored.Size != int64(len(finalHTML)) || stored.Downloaded != int64(len(finalHTML)) {
		t.Fatalf("legacy resource was not canonicalized: %+v", stored)
	}
}

func TestLibraryResumeGuardIgnoresOwnUnverifiedWXMPFile(t *testing.T) {
	s := libraryTestService(t)
	task := model.DownloadTask{Id: 3, PlatformId: "wxmp", Status: model.TaskStatusFailed, Timestamps: model.Timestamps{CreatedAt: 1}}
	if err := s.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	resource := model.DownloadResource{TaskId: &task.Id, UniqueID: "partial_html", Name: "partial_html", Kind: "html", DownloadDir: s.work_dir, Status: 3}
	if err := s.db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.work_dir, resource.Name), []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.libraryResumeGuard(&task); err != nil {
		t.Fatalf("task was blocked by its own partial file: %v", err)
	}
}

func TestLibraryActiveTaskBlocksAndPartialCompletionSkipsExistingResource(t *testing.T) {
	s := libraryTestService(t)
	a := libraryInfo("_720p")
	dir, err := s.libraryPlan(a, true)
	if err != nil {
		t.Fatal(err)
	}
	task := model.DownloadTask{Id: 1, Name: "active", PlatformId: "wxchannels", Status: 2, Timestamps: model.Timestamps{CreatedAt: 1}}
	if err := s.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	r := model.DownloadResource{TaskId: &task.Id, UniqueID: "123_720p", Name: "123_720p.mp4", DownloadDir: dir, Size: 5, Status: 1}
	if err := s.db.Create(&r).Error; err != nil {
		t.Fatal(err)
	}
	var duplicate *DuplicateTaskError
	if err := s.libraryDeduplicate(a, dir); !errors.As(err, &duplicate) {
		t.Fatalf("active request not blocked: %v", err)
	}
	os.MkdirAll(dir, 0755)
	os.WriteFile(filepath.Join(dir, "123_720p.mp4"), []byte("video"), 0600)
	s.db.Model(&task).Update("status", 5)
	s.db.Model(&r).Update("status", 2)
	next := libraryInfo("_720p")
	next.Resources = append(next.Resources, &adapter.ResourceInfo{Resource: model.DownloadResource{UniqueID: "123_cover", Kind: "image/jpeg"}})
	if err := s.libraryDeduplicate(next, dir); err != nil {
		t.Fatal(err)
	}
	if len(next.Resources) != 1 || next.Resources[0].Resource.UniqueID != "123_cover" {
		t.Fatal("existing video would be downloaded again")
	}
}
