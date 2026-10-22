package wxmpadapter

import (
	"strings"
	"testing"
	"time"
)

func TestAssembleWXMPFullHTMLMatchesWechatArticleHeader(t *testing.T) {
	header := wxmp_article_header{
		Title:         `标题 <测试>`,
		Nickname:      "示例公众号",
		ArticleAuthor: "文章作者",
		PublishTime:   "2026年9月29日 12:42",
		Location:      "广东",
	}
	got := assemble_wxmp_full_html_with_header(header, `<section>正文</section>`, false)
	for _, expected := range []string{
		`<h1 class="rich_media_title">标题 &lt;测试&gt;</h1>`,
		`<span class="rich_media_meta rich_media_meta_text">文章作者</span>`,
		`<span class="rich_media_meta rich_media_meta_nickname">示例公众号</span>`,
		`<time class="rich_media_meta rich_media_meta_text">2026年9月29日 12:42</time>`,
		`<span class="rich_media_meta rich_media_meta_text">广东</span>`,
		`<div id="js_content" class="rich_media_content js_underline_content defaultNoSetting"><section>正文</section></div>`,
		`font-size: 22px`,
		`font-weight: 500`,
	} {
		if !strings.Contains(got, expected) {
			t.Fatalf("rendered HTML missing %q", expected)
		}
	}
	if strings.Contains(got, "Like") || strings.Contains(got, "Share") {
		t.Fatal("offline archive must not imitate unavailable WeChat interactions")
	}
}

func TestWXMPArticleContentKeepsExistingWechatContainer(t *testing.T) {
	body := `<div id="js_content" class="rich_media_content">正文</div>`
	got := assemble_wxmp_full_html_with_header(wxmp_article_header{Title: "标题"}, body, false)
	if strings.Count(got, `id="js_content"`) != 1 {
		t.Fatalf("expected one WeChat content container, got %d", strings.Count(got, `id="js_content"`))
	}
}

func TestWXMPArticleHeaderUsesTaskMetadata(t *testing.T) {
	localTime := time.Date(2026, 9, 29, 12, 42, 0, 0, time.Local)
	header := wxmp_article_header_from_metadata("标题", wxmp_task_metadata{
		Author:        "兼容公众号",
		ArticleAuthor: "作者",
		CreatedAt:     localTime.UnixMilli(),
		IPCountry:     "中国",
		IPProvince:    "广东",
		ShowIPWording: 1,
	})
	if header.Nickname != "兼容公众号" || header.ArticleAuthor != "作者" || header.PublishTime != "2026年9月29日 12:42" || header.Location != "广东" {
		t.Fatalf("unexpected header: %#v", header)
	}
}
