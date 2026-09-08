package memory

import (
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

type Problem struct {
	Rel     string `json:"rel"`
	Problem string `json:"problem"`
}

type CheckResult struct {
	OK       bool      `json:"ok"`
	Problems []Problem `json:"problems"`
}

var checkSkipDirs = map[string]bool{".git": true, ".state": true, ".locks": true, "node_modules": true}

// Check is check(): every stray .md outside a type directory is reported and
// scanned for secrets, every concept must parse and sit in a legal
// directory, and every index must equal its regeneration.
func Check(b *Bundle) (CheckResult, error) {
	var problems []Problem
	if err := walkStray(b, b.Root, "", &problems); err != nil {
		return CheckResult{}, err
	}
	dirs, err := b.Dirs()
	if err != nil {
		return CheckResult{}, err
	}
	for _, dir := range dirs {
		entries, err := b.ListConcepts(dir)
		if err != nil {
			return CheckResult{}, err
		}
		for _, typeDir := range TypeDirOrder {
			files, err := os.ReadDir(filepath.Join(dir.Abs, typeDir))
			if err != nil {
				continue
			}
			for _, f := range files {
				if !strings.HasSuffix(f.Name(), ".md") {
					continue
				}
				rel := path.Join(dir.Rel, typeDir, f.Name())
				text, _ := b.Read(rel)
				if _, err := ParseConcept(text); err != nil {
					problems = append(problems, Problem{rel, err.Error()})
				}
			}
		}
		for _, e := range entries {
			if err := ValidateConcept(e.Concept, dir.IsRoot); err != nil {
				problems = append(problems, Problem{e.Rel, err.Error()})
			}
		}
		indexRel := joinRel(dir.Rel, "index.md")
		expected := RenderIndex(entries, dir.Rel, dir.IsRoot)
		actual, ok := b.Read(indexRel)
		switch {
		case !ok:
			problems = append(problems, Problem{indexRel, "missing index"})
		case actual != expected:
			problems = append(problems, Problem{indexRel, "index differs from regeneration"})
		}
	}
	return CheckResult{OK: len(problems) == 0, Problems: problems}, nil
}

func walkStray(b *Bundle, abs, rel string, problems *[]Problem) error {
	entries, err := os.ReadDir(abs)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			if checkSkipDirs[e.Name()] {
				continue
			}
			if err := walkStray(b, filepath.Join(abs, e.Name()), path.Join(rel, e.Name()), problems); err != nil {
				return err
			}
			continue
		}
		if !strings.HasSuffix(e.Name(), ".md") || e.Name() == "index.md" || e.Name() == "log.md" {
			continue
		}
		if slices.Contains(TypeDirOrder, path.Base(rel)) {
			continue
		}
		fileRel := path.Join(rel, e.Name())
		*problems = append(*problems, Problem{fileRel, "unrecognized file"})
		text, _ := b.Read(fileRel)
		if hit := FindSecret(text); hit != nil {
			*problems = append(*problems, Problem{fileRel, "secret (" + hit.Name + ")"})
		}
	}
	return nil
}
