// Package librarypath defines stable names shared by library creation and migration.
package librarypath

import (
	"crypto/sha256"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,120}$`)

func ID(value string) string {
	if safeID.MatchString(value) {
		return value
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(value)))
}
func Account(id, nickname string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(nickname) {
		if b.Len()+len(string(r)) > 60 {
			break
		}
		if unicode.IsControl(r) || strings.ContainsRune(`/\:*?"<>|`, r) {
			r = '_'
		}
		b.WriteRune(r)
	}
	label := strings.Trim(b.String(), ". ")
	if label == "" {
		label = "unknown"
	}
	return label + "__" + fmt.Sprintf("%x", sha256.Sum256([]byte(id)))[:20]
}
func Category(kind string) string {
	switch kind {
	case "video":
		return "videos"
	case "article":
		return "articles"
	case "album", "image":
		return "albums"
	case "audio":
		return "audio"
	default:
		return "other"
	}
}
func Directory(platform, account, contentType, contentID string) string {
	dir := filepath.Join("library", ID(platform), account, Category(contentType))
	if contentType == "article" || contentType == "album" || contentType == "image" {
		dir = filepath.Join(dir, ID(contentID))
	}
	return dir
}
