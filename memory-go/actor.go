package memory

import "regexp"

var (
	actorAgent   = regexp.MustCompile(`^[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+$`)
	actorHuman   = regexp.MustCompile(`^human:[A-Za-z0-9._-]+$`)
	actorProcess = regexp.MustCompile(`^process:[A-Za-z0-9._-]+$`)
)

// Actor is OKF §7 identity: <producer>/<version>, human:<id> or process:<id>.
type Actor struct {
	Value string `json:"value"`
	Class string `json:"class"`
}

func ParseActor(s string) (Actor, error) {
	switch {
	case actorHuman.MatchString(s):
		return Actor{s, "human"}, nil
	case actorProcess.MatchString(s):
		return Actor{s, "process"}, nil
	case actorAgent.MatchString(s):
		return Actor{s, "agent"}, nil
	}
	return Actor{}, Errorf(CodeRefused, "malformed actor %s: use <producer>/<version>, human:<id> or process:<id>", quoteJSON(s))
}
