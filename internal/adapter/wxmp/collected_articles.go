package wxmpadapter

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	result "wx_channel/internal/apiresult"
)

// CollectedArticle is a link verified from WeChat's native search UI.
// This cache does not claim to be a live search index.
type CollectedArticle struct {
	Title   string `json:"title"`
	Author  string `json:"author"`
	Excerpt string `json:"excerpt,omitempty"`
	URL     string `json:"url"`
}

type collectedArticleStore map[string][]CollectedArticle

func validCollectedArticleURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && strings.EqualFold(u.Hostname(), "mp.weixin.qq.com") &&
		(u.Path == "/s" || strings.HasPrefix(u.Path, "/s/")) && u.User == nil
}

func (r *Routes) readCollectedArticles() (collectedArticleStore, error) {
	data, err := os.ReadFile(r.collectedArticlePath)
	if errors.Is(err, os.ErrNotExist) {
		return collectedArticleStore{}, nil
	}
	if err != nil {
		return nil, err
	}
	var saved collectedArticleStore
	if err := json.Unmarshal(data, &saved); err != nil {
		return nil, err
	}
	if saved == nil {
		saved = collectedArticleStore{}
	}
	return saved, nil
}

func (r *Routes) writeCollectedArticles(saved collectedArticleStore) error {
	dir := filepath.Dir(r.collectedArticlePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".collected_article_search-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	encoder := json.NewEncoder(tmp)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(saved); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), r.collectedArticlePath)
}

func (r *Routes) handle_list_collected_articles(ctx *gin.Context) {
	keyword := strings.TrimSpace(ctx.Query("keyword"))
	if keyword == "" || len([]rune(keyword)) > 100 {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	r.collectedArticleMu.Lock()
	saved, err := r.readCollectedArticles()
	r.collectedArticleMu.Unlock()
	if err != nil {
		result.Err(ctx, http.StatusInternalServerError, "读取已采集文章失败")
		return
	}
	articles := saved[keyword]
	if articles == nil {
		articles = []CollectedArticle{}
	}
	result.Ok(ctx, gin.H{"keyword": keyword, "articles": articles})
}

func (r *Routes) handle_save_collected_articles(ctx *gin.Context) {
	var body struct {
		Keyword  string             `json:"keyword"`
		Articles []CollectedArticle `json:"articles"`
	}
	if err := ctx.ShouldBindJSON(&body); err != nil {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	keyword := strings.TrimSpace(body.Keyword)
	if keyword == "" || len([]rune(keyword)) > 100 || len(body.Articles) == 0 || len(body.Articles) > 100 {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	for i := range body.Articles {
		a := &body.Articles[i]
		a.Title = strings.TrimSpace(a.Title)
		a.Author = strings.TrimSpace(a.Author)
		a.Excerpt = strings.TrimSpace(a.Excerpt)
		a.URL = strings.TrimSpace(a.URL)
		if a.Title == "" || len([]rune(a.Title)) > 300 || len([]rune(a.Author)) > 100 || len([]rune(a.Excerpt)) > 1000 || len(a.URL) > 4096 || !validCollectedArticleURL(a.URL) {
			write_api_error(ctx, api_code_invalid_params)
			return
		}
	}
	r.collectedArticleMu.Lock()
	defer r.collectedArticleMu.Unlock()
	saved, err := r.readCollectedArticles()
	if err != nil {
		result.Err(ctx, http.StatusInternalServerError, "读取已采集文章失败")
		return
	}
	seen := make(map[string]bool)
	for _, article := range saved[keyword] {
		seen[article.URL] = true
	}
	for _, article := range body.Articles {
		if !seen[article.URL] {
			saved[keyword] = append(saved[keyword], article)
			seen[article.URL] = true
		}
	}
	if err := r.writeCollectedArticles(saved); err != nil {
		result.Err(ctx, http.StatusInternalServerError, "保存已采集文章失败")
		return
	}
	result.Ok(ctx, gin.H{"keyword": keyword, "articles": saved[keyword]})
}
