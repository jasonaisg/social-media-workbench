package wxmpadapter

import (
	"testing"

	"wx_channel/pkg/scraper/wxmp"
)

func TestToContentUsesSeparateTitleAndEmptyTags(t *testing.T) {
	data := &wxmp.ArticleCgiDataNew{
		Bizuin: "123",
		Mid:    456,
		Idx:    1,
		Title:  "  公众号标题  ",
		Desc:   "  文章摘要  ",
	}
	content, _, err := ToContent(data)
	if err != nil {
		t.Fatal(err)
	}
	if content.Title != "公众号标题" || content.Description != "文章摘要" {
		t.Fatalf("title/description = %q / %q", content.Title, content.Description)
	}
	if content.Tags != "[]" {
		t.Fatalf("tags = %q", content.Tags)
	}
}
