package wxchannelsadapter

import (
	"encoding/json"
	"reflect"
	"testing"

	"wx_channel/pkg/scraper/wxchannels"
)

func TestSplitCaption(t *testing.T) {
	tests := []struct {
		name    string
		caption string
		title   string
		tags    []string
	}{
		{name: "trailing spaced tags", caption: "一天三顿饭 #饭 #健康 #科普 ", title: "一天三顿饭", tags: []string{"饭", "健康", "科普"}},
		{name: "attached tags", caption: "低谷也是改写#低谷#命运#人生", title: "低谷也是改写", tags: []string{"低谷", "命运", "人生"}},
		{name: "unicode spacing", caption: "正文　#AI　#大模型", title: "正文", tags: []string{"AI", "大模型"}},
		{name: "leading tag", caption: "#媒体人精选计划 长江后浪推前浪 #荆州", title: "长江后浪推前浪", tags: []string{"媒体人精选计划", "荆州"}},
		{name: "mention after tag", caption: "正文 #时代IP挑战赛@大童保险服务 @作者", title: "正文 @大童保险服务 @作者", tags: []string{"时代IP挑战赛"}},
		{name: "deduplicates", caption: "正文 #AI #AI #视频", title: "正文", tags: []string{"AI", "视频"}},
		{name: "plain caption", caption: "  没有话题的标题  ", title: "没有话题的标题", tags: []string{}},
		{name: "bare hash is text", caption: "C# 教程", title: "C# 教程", tags: []string{}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			title, tags := SplitCaption(test.caption)
			if title != test.title {
				t.Fatalf("title = %q, want %q", title, test.title)
			}
			if !reflect.DeepEqual(tags, test.tags) {
				t.Fatalf("tags = %#v, want %#v", tags, test.tags)
			}
		})
	}
}

func TestToContentSeparatesCaptionTags(t *testing.T) {
	obj := &wxchannels.ChannelsObject{ID: "123"}
	obj.ObjectDesc.MediaType = 4
	obj.ObjectDesc.Description = "视频标题 #AI #大模型 #AI"
	obj.ObjectDesc.Media = []wxchannels.ChannelsMediaItem{{URL: "https://example.com/video.mp4"}}

	content, _, err := ToContent(obj)
	if err != nil {
		t.Fatal(err)
	}
	if content.Title != "视频标题" {
		t.Fatalf("title = %q", content.Title)
	}
	if content.Description != obj.ObjectDesc.Description {
		t.Fatalf("description was not preserved: %q", content.Description)
	}
	var tags []string
	if err := json.Unmarshal([]byte(content.Tags), &tags); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tags, []string{"AI", "大模型"}) {
		t.Fatalf("tags = %#v", tags)
	}
	if ObjectTitle(obj) != "视频标题" {
		t.Fatalf("download title = %q", ObjectTitle(obj))
	}
}

func TestBuildDownloadTaskUsesTagFreeTitle(t *testing.T) {
	a := &ChannelsAdapter{}
	raw := json.RawMessage(`{"id":"123","contact":{"username":"author","nickname":"Author"},"objectDesc":{"mediaType":4,"description":"视频标题 #AI #大模型","media":[{"url":"https://example.com/video.mp4","decodeKey":"12345","fileSize":100,"videoPlayLen":5}]}}`)
	info, err := a.BuildDownloadTask(raw, json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if info.Content.Title != "视频标题" || info.Task.Name != "视频标题" {
		t.Fatalf("content/task titles = %q / %q", info.Content.Title, info.Task.Name)
	}
	if len(info.Resources) == 0 {
		t.Fatal("download task has no resources")
	}
	var extra struct {
		Title    string `json:"title"`
		Filename string `json:"filename"`
	}
	if err := json.Unmarshal([]byte(info.Resources[0].Resource.Extra), &extra); err != nil {
		t.Fatal(err)
	}
	if extra.Title != "视频标题" || extra.Filename != "视频标题" {
		t.Fatalf("resource titles = %q / %q", extra.Title, extra.Filename)
	}
}
