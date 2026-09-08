package memory

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

const fixtures = "../test/fixtures/transcripts"

func TestTranscriptGolden(t *testing.T) {
	for _, name := range []string{"pi", "claude"} {
		p := filepath.Join(fixtures, name+".jsonl")
		format, err := DetectFormat(p)
		if err != nil || format != name {
			t.Fatalf("DetectFormat(%s) = %q, %v", name, format, err)
		}
		entries, _, err := ReadDelta(p, format, 0)
		if err != nil {
			t.Fatal(err)
		}
		want, _ := os.ReadFile(filepath.Join(goldenDir, "transcript", name+".txt"))
		if got := SerializeEntries(entries); got != string(want) {
			t.Errorf("%s serialize differs\n--- got ---\n%s\n--- want ---\n%s", name, got, want)
		}
	}
	raw, _ := os.ReadFile(filepath.Join(goldenDir, "transcript", "pi-from.json"))
	var want struct {
		From    int64             `json:"from"`
		Bytes   int64             `json:"bytes"`
		Entries []TranscriptEntry `json:"entries"`
	}
	json.Unmarshal(raw, &want)
	entries, bytes, _ := ReadDelta(filepath.Join(fixtures, "pi.jsonl"), "pi", want.From)
	if bytes != want.Bytes || !reflect.DeepEqual(entries, want.Entries) {
		t.Errorf("ReadDelta from %d: bytes %d want %d, entries %+v want %+v", want.From, bytes, want.Bytes, entries, want.Entries)
	}
	c := loadCases(t).CapDelta
	if got := CapDelta(c.Input.Entries, c.Input.MaxTokens); !reflect.DeepEqual(got, c.Expected) {
		t.Errorf("CapDelta = %+v, want %+v", got, c.Expected)
	}
}

func TestReadDeltaEdges(t *testing.T) {
	p := filepath.Join(t.TempDir(), "t.jsonl")
	os.WriteFile(p, []byte(`{"type":"message","id":"a","timestamp":"t","message":{"role":"user","content":"hi"}}`+"\n"+`{"type":"message","id":"b","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"yo"}]}}`), 0o644)
	entries, bytes, _ := ReadDelta(p, "pi", 0)
	if len(entries) != 1 || entries[0].Text != "hi" {
		t.Errorf("incomplete last line must be skipped: %+v", entries)
	}
	info, _ := os.Stat(p)
	if bytes != info.Size()-int64(len(`{"type":"message","id":"b","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"yo"}]}}`)) {
		t.Errorf("bytes %d", bytes)
	}
	if _, resetBytes, _ := ReadDelta(p, "pi", info.Size()+100); resetBytes != bytes {
		t.Errorf("offset past the end resets to zero: got %d, want %d (same as fromBytes=0)", resetBytes, bytes)
	}
	got, _ := ReadEntries(p, "pi", []string{"a"})
	if len(got) != 1 || got[0].ID != "a" {
		t.Error("ReadEntries filters by id")
	}
}
