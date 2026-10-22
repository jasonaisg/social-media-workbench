package wxmp

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

var nativeChannelsProfileUsernamePattern = regexp.MustCompile(`^[A-Za-z0-9_]+@finder$`)

func normalizeNativeChannelsProfileUsername(value string) (string, error) {
	username := strings.TrimSpace(value)
	if username == "" || len(username) > 256 || !nativeChannelsProfileUsernamePattern.MatchString(username) {
		return "", new_scraper_error(ErrorKindInvalidArgument, ErrorMessage(ErrorKindInvalidArgument), errors.New("invalid Channels profile username"))
	}
	return username, nil
}

// OpenNativeChannelsProfile asks the injected search bridge to open a validated
// Finder profile. The bridge bypasses WeChat's desktop compatibility wrapper,
// whose final native WebView call can report success without creating a page.
func (c *OfficialAccountServer) OpenNativeChannelsProfile(username string) (json.RawMessage, error) {
	username, err := normalizeNativeChannelsProfileUsername(username)
	if err != nil {
		return nil, err
	}
	args, err := json.Marshal(map[string]any{
		"userName": username,
	})
	if err != nil {
		return nil, err
	}
	return c.CallJSAPIOnClientTitle(JSAPIRequest{
		Operation: "invoke",
		Method:    "openFinderProfile",
		Args:      args,
		TimeoutMS: 8000,
	}, NativeArticleSearchClientTitle)
}
