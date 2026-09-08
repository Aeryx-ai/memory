package memory

type TranscriptEntry struct {
	ID   string `json:"id"`
	Role string `json:"role"`
	At   string `json:"at"`
	Text string `json:"text"`
}
