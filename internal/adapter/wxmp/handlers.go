package wxmpadapter

import (
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	result "wx_channel/internal/apiresult"
	"wx_channel/internal/services"
	"wx_channel/pkg/scraper/wxmp"
)

var proxy_image_url_reg = regexp.MustCompile(`https?://mmbiz\.qpic\.cn/(?:[a-zA-Z0-9_]+/)*[a-zA-Z0-9_]+/[^\s"']+`)

func (r *Routes) handle_websocket(ctx *gin.Context) {
	r.server.ServeWebsocket(ctx.Writer, ctx.Request)
}

func (r *Routes) handle_fetch_message_list(ctx *gin.Context) {
	if !r.server.ValidateToken(ctx.Query("token")) {
		write_api_error(ctx, api_code_token_invalid)
		return
	}
	offset, parse_err := strconv.Atoi(ctx.Query("offset"))
	if parse_err != nil {
		offset = 0
	}
	data, err := r.server.FetchMessageList(wxmp.FetchMessageListParams{
		Biz:        ctx.Query("biz"),
		Offset:     offset,
		Uin:        ctx.Query("uin"),
		Key:        ctx.Query("key"),
		PassTicket: ctx.Query("pass_ticket"),
	})
	if err != nil {
		write_client_error(ctx, err, api_code_fetch_message)
		return
	}
	result.Ok(ctx, data)
}

func (r *Routes) handle_fetch_article_list(ctx *gin.Context) {
	biz := ctx.Query("biz")
	if biz == "" {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	data, err := r.server.FetchArticleList(biz)
	if err != nil {
		write_client_error(ctx, err, api_code_fetch_message)
		return
	}
	result.Ok(ctx, data)
}

func (r *Routes) handle_search_native_articles(ctx *gin.Context) {
	r.handle_search_native(ctx, r.server.SearchNativeArticles)
}

func (r *Routes) handle_article_download_status(ctx *gin.Context) {
	if r.db == nil {
		result.Err(ctx, http.StatusServiceUnavailable, "数据库不可用")
		return
	}
	var body struct {
		URLs []string `json:"urls"`
	}
	if err := ctx.ShouldBindJSON(&body); err != nil || len(body.URLs) == 0 || len(body.URLs) > 100 {
		result.Err(ctx, api_code_invalid_params, "每次请提交1至100个文章链接")
		return
	}
	statuses := make(map[string]string, len(body.URLs))
	content_ids := make([]string, 0, len(body.URLs))
	content_id_by_url := make(map[string]string, len(body.URLs))
	for _, raw_url := range body.URLs {
		raw_url = strings.TrimSpace(raw_url)
		if raw_url == "" || len(raw_url) > 4096 {
			continue
		}
		statuses[raw_url] = "unknown"
		external_id := ArticleExternalIDFromURL(raw_url)
		if external_id == "" {
			continue
		}
		content_id := BuildContentID(external_id)
		content_id_by_url[raw_url] = content_id
		content_ids = append(content_ids, content_id)
	}
	downloaded, err := services.DownloadedContentStatus(r.db, content_ids)
	if err != nil {
		result.Err(ctx, http.StatusInternalServerError, "核对本地下载状态失败")
		return
	}
	for raw_url, content_id := range content_id_by_url {
		if downloaded[content_id] {
			statuses[raw_url] = "downloaded"
		} else {
			statuses[raw_url] = "not_downloaded"
		}
	}
	result.Ok(ctx, gin.H{"statuses": statuses})
}

func (r *Routes) handle_search_native_official_account_articles(ctx *gin.Context) {
	username := strings.TrimSpace(ctx.Query("username"))
	if username == "" || len(username) > 256 {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	r.handle_search_native(ctx, func(keyword string, offset int, cookies string, searchID string, diffRequestID string) (json.RawMessage, error) {
		return r.server.SearchNativeOfficialAccountArticles(keyword, username, offset, cookies, searchID, diffRequestID)
	})
}

func (r *Routes) handle_search_native_official_account_articles_post(ctx *gin.Context) {
	var body struct {
		Keyword       string `json:"keyword"`
		Username      string `json:"username"`
		Offset        int    `json:"offset"`
		Cookies       string `json:"cookies"`
		SearchID      string `json:"search_id"`
		DiffRequestID string `json:"diff_request_id"`
	}
	if err := ctx.ShouldBindJSON(&body); err != nil {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	body.Keyword = strings.TrimSpace(body.Keyword)
	body.Username = strings.TrimSpace(body.Username)
	body.SearchID = strings.TrimSpace(body.SearchID)
	body.DiffRequestID = strings.TrimSpace(body.DiffRequestID)
	if body.Keyword == "" || len([]rune(body.Keyword)) > 100 || body.Username == "" || len(body.Username) > 256 || body.Offset < 0 || body.Offset > 1000 || len(body.Cookies) > 1024*1024 || len(body.SearchID) > 256 || len(body.DiffRequestID) > 256 {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	data, err := r.server.SearchNativeOfficialAccountArticles(body.Keyword, body.Username, body.Offset, body.Cookies, body.SearchID, body.DiffRequestID)
	if err != nil {
		write_client_error(ctx, err, api_code_jsapi)
		return
	}
	result.Ok(ctx, data)
}

func (r *Routes) handle_search_native_official_accounts(ctx *gin.Context) {
	r.handle_search_native(ctx, r.server.SearchNativeOfficialAccounts)
}

func (r *Routes) handle_search_native(ctx *gin.Context, search func(string, int, string, string, string) (json.RawMessage, error)) {
	keyword := strings.TrimSpace(ctx.Query("keyword"))
	searchID := strings.TrimSpace(ctx.Query("search_id"))
	diffRequestID := strings.TrimSpace(ctx.Query("diff_request_id"))
	offset, err := strconv.Atoi(ctx.DefaultQuery("offset", "0"))
	if err != nil || keyword == "" || len([]rune(keyword)) > 100 || offset < 0 || offset > 1000 || len(ctx.Query("cookies")) > 8192 || len(searchID) > 256 || len(diffRequestID) > 256 {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	data, err := search(keyword, offset, ctx.Query("cookies"), searchID, diffRequestID)
	if err != nil {
		write_client_error(ctx, err, api_code_jsapi)
		return
	}
	result.Ok(ctx, data)
}

func (r *Routes) handle_native_article_search_status(ctx *gin.Context) {
	connected := r.server.HasHealthyClientTitle(wxmp.NativeArticleSearchClientTitle)
	result.Ok(ctx, gin.H{
		"connected": connected,
		"message": map[bool]string{
			true:  "微信搜一搜已连接",
			false: "请在电脑微信打开或刷新搜一搜页面",
		}[connected],
	})
}

func (r *Routes) handle_open_native_channels(ctx *gin.Context) {
	if r.db == nil {
		result.Err(ctx, api_code_client_not_ready, "生产内容库不可用，无法选择视频号启动账号")
		return
	}
	var candidates []struct {
		SourceURL string `gorm:"column:source_url"`
	}
	if err := r.db.Table("content").Select("source_url").
		Where("platform_id = ? AND deleted_at IS NULL AND source_url <> ''", "wxchannels").
		Order("updated_at DESC").Limit(50).Scan(&candidates).Error; err != nil {
		result.Err(ctx, http.StatusInternalServerError, "读取视频号启动账号失败")
		return
	}
	username := ""
	for _, candidate := range candidates {
		parsed, err := url.Parse(strings.TrimSpace(candidate.SourceURL))
		if err == nil && strings.EqualFold(parsed.Hostname(), "channels.weixin.qq.com") {
			username = strings.TrimSpace(parsed.Query().Get("username"))
			if username != "" {
				break
			}
		}
	}
	if username == "" {
		result.Err(ctx, api_code_client_not_ready, "生产内容库里没有可用于启动的视频号作者记录")
		return
	}
	data, err := r.server.OpenNativeChannelsProfile(username)
	if err != nil {
		write_client_error(ctx, err, api_code_jsapi)
		return
	}
	result.Ok(ctx, data)
}

func (r *Routes) handle_open_official_account_history(ctx *gin.Context) {
	var body struct {
		Biz        string `json:"biz"`
		ProfileURL string `json:"profile_url"`
	}
	if err := ctx.ShouldBindJSON(&body); err != nil {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	data, err := r.server.OpenNativeOfficialAccountHistory(body.ProfileURL, body.Biz)
	if err != nil {
		write_client_error(ctx, err, api_code_jsapi)
		return
	}
	result.Ok(ctx, data)
}

func (r *Routes) handle_official_account_history_status(ctx *gin.Context) {
	biz := strings.TrimSpace(ctx.Query("biz"))
	if biz == "" {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	connected := r.server.HasHealthyOfficialAccountHistory(biz)
	result.Ok(ctx, gin.H{
		"connected": connected,
		"message": map[bool]string{
			true:  "公众号历史消息页已连接",
			false: "正在等待公众号历史消息页连接",
		}[connected],
	})
}

func (r *Routes) handle_fetch_official_account_history(ctx *gin.Context) {
	biz := strings.TrimSpace(ctx.Query("biz"))
	offset, err := strconv.Atoi(ctx.DefaultQuery("offset", "0"))
	if err != nil || biz == "" || offset < 0 || offset > 100000 {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	data, err := r.server.FetchNativeOfficialAccountHistory(biz, offset)
	if err != nil {
		write_client_error(ctx, err, api_code_fetch_message)
		return
	}
	result.Ok(ctx, data)
}

func (r *Routes) handle_fetch_biz_msg_list(ctx *gin.Context) {
	data, err := r.server.FetchBizMsgList(
		ctx.Query("username"),
		ctx.Query("offset"),
	)
	if err != nil {
		write_client_error(ctx, err, api_code_fetch_message)
		return
	}
	result.Ok(ctx, data)
}

func (r *Routes) handle_fetch_page_content(ctx *gin.Context) {
	if !r.server.ValidateToken(ctx.Query("token")) {
		write_api_error(ctx, api_code_token_invalid)
		return
	}
	data, err := r.server.FetchPageContent(ctx.Query("url"))
	if err != nil {
		write_client_error(ctx, err, api_code_fetch_page_content)
		return
	}
	result.Ok(ctx, data)
}

func (r *Routes) handle_jsapi(ctx *gin.Context) {
	if !r.server.ValidateToken(ctx.Query("token")) {
		write_api_error(ctx, api_code_token_invalid)
		return
	}
	var body wxmp.JSAPIRequest
	if err := ctx.ShouldBindJSON(&body); err != nil {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	data, err := r.server.CallJSAPI(body)
	if err != nil {
		write_client_error(ctx, err, api_code_jsapi)
		return
	}
	result.Ok(ctx, data)
}

func (r *Routes) handle_fetch_list(ctx *gin.Context) {
	token := ctx.Query("token")
	if !r.server.ValidateToken(token) {
		write_api_error(ctx, api_code_token_invalid)
		return
	}
	page, page_err := strconv.Atoi(ctx.Query("page"))
	if page_err != nil {
		page = 1
	}
	page_size, page_size_err := strconv.Atoi(ctx.Query("page_size"))
	if page_size_err != nil {
		page_size = 10
	}
	var effective *bool
	if raw_effective := ctx.Query("is_effective"); raw_effective != "" {
		value := raw_effective == "1" || strings.EqualFold(raw_effective, "true")
		effective = &value
	}
	data := r.server.ListOfficialAccounts(wxmp.ListOfficialAccountsParams{
		Page:      page,
		PageSize:  page_size,
		Keyword:   ctx.Query("keyword"),
		Effective: effective,
		Token:     token,
	})
	result.Ok(ctx, data)
}

func (r *Routes) handle_delete(ctx *gin.Context) {
	if !r.server.ValidateRefreshToken(ctx.Query("token")) {
		write_api_error(ctx, api_code_token_invalid)
		return
	}
	var body wxmp.OfficialAccountBody
	if err := ctx.ShouldBindJSON(&body); err != nil {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	if body.Biz == "" {
		write_api_error(ctx, api_code_missing_biz)
		return
	}
	r.server.DeleteOfficialAccount(body.Biz)
	result.Ok(ctx, nil)
}

func (r *Routes) handle_refresh_event(ctx *gin.Context) {
	if !r.server.ValidateRefreshToken(ctx.Query("token")) {
		write_api_error(ctx, api_code_token_invalid)
		return
	}
	var body wxmp.OfficialAccount
	if err := ctx.ShouldBindJSON(&body); err != nil {
		write_api_error(ctx, api_code_invalid_params)
		return
	}
	if body.Biz == "" || body.Key == "" {
		write_api_error(ctx, api_code_missing_biz)
		return
	}
	r.server.RefreshOfficialAccount(body)
	result.Ok(ctx, nil)
}

func (r *Routes) handle_refresh_with_frontend(ctx *gin.Context) {
	if err := r.server.Validate(); err != nil {
		write_api_error(ctx, api_code_client_not_ready)
		return
	}
	var body struct {
		BizList []string `json:"biz_list"`
	}
	_ = ctx.ShouldBindJSON(&body)
	if err := r.server.RefreshSpecifiedOfficialAccountList(body.BizList); err != nil {
		write_client_error(ctx, err, 1001)
		return
	}
	result.Ok(ctx, nil)
}

func (r *Routes) handle_official_account_rss(ctx *gin.Context) {
	if !r.server.ValidateToken(ctx.Query("token")) {
		write_api_error(ctx, api_code_token_invalid)
		return
	}
	offset, parse_err := strconv.Atoi(ctx.Query("offset"))
	if parse_err != nil {
		offset = 0
	}
	feed, err := r.server.BuildRSS(wxmp.RSSParams{
		Biz:            ctx.Query("biz"),
		Offset:         offset,
		IncludeContent: ctx.Query("content") == "1",
		ProxyLinks:     ctx.Query("proxy") == "1",
		ProxyCover:     ctx.Query("proxy_cover") == "1",
		SelfURL:        "http://" + ctx.Request.Host + ctx.Request.RequestURI,
	})
	if err != nil {
		write_client_error(ctx, err, api_code_fetch_message)
		return
	}
	ctx.Header("Content-Type", "application/atom+xml; charset=utf-8")
	ctx.XML(http.StatusOK, feed)
}

func (r *Routes) handle_official_account_proxy(ctx *gin.Context) {
	if !r.server.ValidateToken(ctx.Query("token")) {
		write_api_error(ctx, api_code_token_invalid)
		return
	}
	target_url := ctx.Query("url")
	if target_url == "" {
		write_api_error(ctx, api_code_missing_url)
		return
	}
	response, err := r.server.FetchOfficialAccountProxy(target_url)
	if err != nil {
		write_client_error(ctx, err, api_code_proxy_dispatch)
		return
	}
	defer response.Body.Close()
	for key, values := range response.Header {
		if key == "Content-Length" {
			continue
		}
		for _, value := range values {
			ctx.Header(key, value)
		}
	}
	ctx.Status(response.StatusCode)
	if !strings.Contains(response.Header.Get("Content-Type"), "text/html") {
		_, _ = io.Copy(ctx.Writer, response.Body)
		return
	}
	body, read_err := io.ReadAll(response.Body)
	if read_err != nil {
		return
	}
	remote_server := r.server.RemoteServerAddress()
	rewritten := proxy_image_url_reg.ReplaceAllStringFunc(string(body), func(match string) string {
		image_url := html.UnescapeString(match)
		return fmt.Sprintf("%s/mp/proxy?url=%s", remote_server, url.QueryEscape(image_url))
	})
	_, _ = ctx.Writer.Write([]byte(rewritten))
}

func (r *Routes) handle_fetch_official_account_clients(ctx *gin.Context) {
	result.Ok(ctx, gin.H{"list": r.server.ClientStatuses()})
}

func write_client_error(ctx *gin.Context, err error, fallback_code int) {
	code := fallback_code
	message := err.Error()
	if error_kind, error_message, location, ok := wxmp.ErrorDetails(err); ok {
		code = api_code_for_error_kind(error_kind, fallback_code)
		message = error_message
		if location != "" {
			message = fmt.Sprintf("%s (loc=%s)", message, location)
		}
	}
	result.Err(ctx, code, message)
}
