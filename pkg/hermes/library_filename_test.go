package hermes

import "testing"

func TestLibraryFilenameIgnoresTitleAndTemplate(t *testing.T) {
	got := BuildFinalResourceName(FinalResourceNameInput{TaskName: "long title", TaskConfig: map[string]any{"library_managed": true}, ResourceUniqueID: "123_xWT111", ResourceName: "postprocessor title", ResourceKind: "video/mp4", FilenameTemplate: "{{filename}}_{{spec}}"})
	if got.Name != "123_xWT111.mp4" {
		t.Fatal(got.Name)
	}
	again := BuildFinalResourceName(FinalResourceNameInput{TaskName: "changed", TaskConfig: map[string]any{"library_managed": true}, ResourceName: got.Name, ResourceKind: "video/mp4"})
	if again.Name != got.Name {
		t.Fatal(again.Name)
	}
}
