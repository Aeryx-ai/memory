package memory

var Types = []string{"User", "Feedback", "Project", "Reference", "Session Summary"}

// TypeDirOrder is the iteration order Node gets from Object.values(TYPE_DIRS);
// ListConcepts reads directories in this order before sorting.
var TypeDirOrder = []string{"user", "feedback", "project", "reference", "session-summaries"}

var TypeDirs = map[string]string{
	"User": "user", "Feedback": "feedback", "Project": "project", "Reference": "reference", "Session Summary": "session-summaries",
}

func DirForType(t string) string { return TypeDirs[t] }

func TypeForDir(dir string) string {
	for _, t := range Types {
		if TypeDirs[t] == dir {
			return t
		}
	}
	return ""
}

// LegalTypes: the root takes everything but Project, a project directory
// everything but User.
func LegalTypes(isRoot bool) []string {
	out := make([]string, 0, len(Types)-1)
	for _, t := range Types {
		if (isRoot && t == "Project") || (!isRoot && t == "User") {
			continue
		}
		out = append(out, t)
	}
	return out
}

func IsType(t string) bool { _, ok := TypeDirs[t]; return ok }
