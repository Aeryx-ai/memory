package memory

type Observation struct {
	ID        string `json:"id"`
	At        string `json:"at"`
	Relevance string `json:"relevance"`
	Content   string `json:"content"`
}

type Reflection struct {
	ID       string   `json:"id"`
	Content  string   `json:"content"`
	Supports []string `json:"supports"`
}

type SummaryBody struct {
	Reflections  []Reflection  `json:"reflections"`
	Observations []Observation `json:"observations"`
}
