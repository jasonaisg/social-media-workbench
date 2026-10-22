package wxchannelsadapter

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"wx_channel/internal/database/model"
	"wx_channel/pkg/scraper/wxchannels"
)

var captionTagPattern = regexp.MustCompile(`#([^#@\s\p{Z}]+)`)

// SplitCaption separates WeChat Channels topic markers from the human-readable
// caption. The original caption must still be stored as Content.Description so
// this normalization never discards source data.
func SplitCaption(caption string) (string, []string) {
	caption = strings.TrimSpace(caption)
	matches := captionTagPattern.FindAllStringSubmatch(caption, -1)
	tags := make([]string, 0, len(matches))
	seen := make(map[string]struct{}, len(matches))
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		tag := strings.TrimSpace(match[1])
		if tag == "" {
			continue
		}
		if _, exists := seen[tag]; exists {
			continue
		}
		seen[tag] = struct{}{}
		tags = append(tags, tag)
	}

	title := strings.Join(strings.Fields(captionTagPattern.ReplaceAllString(caption, " ")), " ")
	return title, tags
}

func captionTagsJSON(tags []string) string {
	if tags == nil {
		tags = []string{}
	}
	encoded, _ := json.Marshal(tags)
	return string(encoded)
}

// PickSpec returns the first h264 spec's FileFormat from the object, or "original" if none.
func PickSpec(obj *wxchannels.ChannelsObject) string {
	specs := obj.Spec
	if len(obj.ObjectDesc.Media) > 0 && len(obj.ObjectDesc.Media[0].Spec) > 0 {
		specs = obj.ObjectDesc.Media[0].Spec
	}
	if len(specs) > 0 {
		return specs[0].FileFormat
	}
	return ""
}

// BuildDownloadURLWithSpec returns the download URL for the given spec.
//
//   - If spec is a codec name (e.g. "xWT111"), appends &X-snsvideoflag= to the base URL.
//   - If spec is "" or "original", strips all query params except encfilekey and token,
//     mirroring the JS __wx_channels_download4 original-video logic.
//   - zip:// URLs are returned as-is.
func BuildDownloadURLWithSpec(obj *wxchannels.ChannelsObject, spec string) string {
	base_url := ObjectURL(obj)

	if spec == "" || spec == "original" {
		return base_url
		// parsed_url, err := url.Parse(base_url)
		// if err != nil {
		// 	return base_url
		// }
		// base_query := parsed_url.Query()
		// original_query := url.Values{}
		// for _, key := range []string{"encfilekey", "token"} {
		// 	for _, value := range base_query[key] {
		// 		original_query.Add(key, value)
		// 	}
		// }
		// parsed_url.RawQuery = original_query.Encode()
		// return parsed_url.String()
	}

	return base_url + "&X-snsvideoflag=" + spec
}

// DecryptKeyInt returns the video decrypt key as int, or 0 on failure.
func DecryptKeyInt(obj *wxchannels.ChannelsObject) int {
	if len(obj.ObjectDesc.Media) == 0 {
		return 0
	}
	key, err := strconv.Atoi(obj.ObjectDesc.Media[0].DecodeKey)
	if err != nil {
		return 0
	}
	return key
}

// ObjectTitle returns the tag-free object title with fallback logic
// (description → ID → timestamp).
func ObjectTitle(obj *wxchannels.ChannelsObject) string {
	if obj.LiveInfo != nil {
		return "直播"
	}
	title, _ := SplitCaption(obj.ObjectDesc.Description)
	if title != "" {
		return title
	}
	if strings.TrimSpace(obj.ID) != "" {
		return obj.ID
	}
	return strconv.FormatInt(time.Now().Unix(), 10)
}

// DecryptKey exposes the legacy channels conversion capability through the
// registered handler, so callers do not need to import this package.
func (a *ChannelsAdapter) DecryptKey(content_json json.RawMessage) (int, error) {
	var obj wxchannels.ChannelsObject
	if err := json.Unmarshal(content_json, &obj); err != nil {
		return 0, err
	}
	return DecryptKeyInt(&obj), nil
}

// ConvertContent converts a raw channels object into the shared content model.
func (a *ChannelsAdapter) ConvertContent(content_json json.RawMessage) (*model.Content, error) {
	var obj wxchannels.ChannelsObject
	if err := json.Unmarshal(content_json, &obj); err != nil {
		return nil, err
	}
	content, _, err := ToContent(&obj)
	return content, err
}
