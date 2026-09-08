package memory

import (
	"encoding/json"
	"os"
	"strings"

	"github.com/aeryx-ai/memory/memory-go/internal/js"
)

type TranscriptEntry struct {
	ID   string `json:"id"`
	Role string `json:"role"`
	At   string `json:"at"`
	Text string `json:"text"`
}

// DetectFormat reads the first 200 bytes: a pi session file opens with a
// {"type":"session"} row, anything else is a Claude Code transcript.
func DetectFormat(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	buf := make([]byte, 200)
	n, _ := f.Read(buf)
	if strings.Contains(string(buf[:n]), `"type":"session"`) {
		return "pi", nil
	}
	return "claude", nil
}

type blockNames struct{ call, args, result string }

var (
	piNames     = blockNames{"toolCall", "arguments", "toolResultNever"}
	claudeNames = blockNames{"tool_use", "input", "tool_result"}
)

func clip(s string) string {
	if js.Len16(s) > 2000 {
		return js.Slice16(s, 2000) + "…"
	}
	return s
}

func argsJSON(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return "{}"
	}
	s, err := js.JSONStringify(raw)
	if err != nil {
		return "{}"
	}
	return s
}

// blocksToText is blocksToText(): a string is itself; blocks contribute
// their text, a tool call as "call name(args)", a tool result as
// "result: …" clipped to 2000 characters.
func blocksToText(content json.RawMessage, names blockNames) string {
	var s string
	if json.Unmarshal(content, &s) == nil {
		return s
	}
	var rawBlocks []map[string]json.RawMessage
	if json.Unmarshal(content, &rawBlocks) != nil {
		return ""
	}
	var out []string
	for _, rb := range rawBlocks {
		var typ, text, name string
		json.Unmarshal(rb["type"], &typ)
		json.Unmarshal(rb["text"], &text)
		json.Unmarshal(rb["name"], &name)
		switch {
		case typ == "text" && text != "":
			out = append(out, text)
		case typ == names.call:
			out = append(out, "call "+name+"("+argsJSON(rb[names.args])+")")
		case typ == names.result:
			var str string
			if json.Unmarshal(rb["content"], &str) == nil {
				out = append(out, "result: "+clip(str))
			} else {
				out = append(out, "result: "+clip(blocksToText(rb["content"], names)))
			}
		}
	}
	return strings.Join(out, "\n")
}

type piRow struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Message   *struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type claudeRow struct {
	Type      string `json:"type"`
	UUID      string `json:"uuid"`
	Timestamp string `json:"timestamp"`
	Message   *struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

func fromPi(line []byte) (TranscriptEntry, bool) {
	var row piRow
	if json.Unmarshal(line, &row) != nil || row.Type != "message" || row.Message == nil {
		return TranscriptEntry{}, false
	}
	text := blocksToText(row.Message.Content, piNames)
	if row.Message.Role == "toolResult" {
		text = "result: " + clip(text)
	}
	return TranscriptEntry{ID: row.ID, Role: row.Message.Role, At: row.Timestamp, Text: text}, true
}

func fromClaude(line []byte) (TranscriptEntry, bool) {
	var row claudeRow
	if json.Unmarshal(line, &row) != nil || (row.Type != "user" && row.Type != "assistant") {
		return TranscriptEntry{}, false
	}
	var content json.RawMessage
	if row.Message != nil {
		content = row.Message.Content
	}
	isResult := false
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(content, &blocks) == nil {
		for _, b := range blocks {
			var typ string
			json.Unmarshal(b["type"], &typ)
			if typ == "tool_result" {
				isResult = true
			}
		}
	}
	role := row.Type
	if isResult {
		role = "toolResult"
	}
	return TranscriptEntry{ID: row.UUID, Role: role, At: row.Timestamp, Text: blocksToText(content, claudeNames)}, true
}

// ReadDelta reads the complete lines from fromBytes to the end of the file,
// converts each row it understands and returns the byte offset just past
// the last complete line. An offset beyond the file starts over at zero.
func ReadDelta(path, format string, fromBytes int64) ([]TranscriptEntry, int64, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, err
	}
	if fromBytes > int64(len(raw)) {
		fromBytes = 0
	}
	text := raw[fromBytes:]
	end := strings.LastIndexByte(string(text), '\n')
	complete := ""
	if end >= 0 {
		complete = string(text[:end+1])
	}
	entries := []TranscriptEntry{}
	for _, line := range strings.Split(complete, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var e TranscriptEntry
		var ok bool
		if format == "pi" {
			e, ok = fromPi([]byte(line))
		} else {
			e, ok = fromClaude([]byte(line))
		}
		if ok {
			entries = append(entries, e)
		}
	}
	return entries, fromBytes + int64(len(complete)), nil
}

func ReadEntries(path, format string, ids []string) ([]TranscriptEntry, error) {
	entries, _, err := ReadDelta(path, format, 0)
	if err != nil {
		return nil, err
	}
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	out := []TranscriptEntry{}
	for _, e := range entries {
		if want[e.ID] {
			out = append(out, e)
		}
	}
	return out, nil
}

func SerializeEntries(entries []TranscriptEntry) string {
	var b strings.Builder
	for _, e := range entries {
		b.WriteString("--- " + e.ID + " " + e.Role + " " + e.At + "\n" + e.Text + "\n")
	}
	return b.String()
}

// CapDelta keeps the newest entries whose serialized size fits maxTokens,
// always at least the last one. One pass, newest to oldest.
func CapDelta(entries []TranscriptEntry, maxTokens int) []TranscriptEntry {
	n := len(entries)
	if n == 0 {
		return entries
	}
	bytes := len(SerializeEntries(entries[n-1:]))
	start := n - 1
	for i := n - 2; i >= 0; i-- {
		next := bytes + len(SerializeEntries(entries[i:i+1]))
		if (next+3)/4 > maxTokens {
			break
		}
		bytes = next
		start = i
	}
	return entries[start:]
}
