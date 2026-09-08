package memory

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/aeryx-ai/memory/memory-go/internal/js"
)

const rootIndex = "---\nokf_version: \"0.2\"\n---\n"

// Bundle is the OKF bundle at Root, a git work tree. It is the only writer
// of concept files, indexes and logs; every write is temp-then-rename.
type Bundle struct {
	Root string
}

type Dir struct {
	Rel       string // "" for the root, projects/<id> otherwise
	Abs       string
	IsRoot    bool
	ProjectID string
}

type Entry struct {
	Rel     string
	Concept *Concept
}

// ResolveRoot is Bundle.resolveRoot: an explicit dir, else MEMORY_DIR, else
// $HOME/.agents/memory.
func ResolveRoot(dir string, getenv func(string) string) string {
	if dir != "" {
		abs, _ := filepath.Abs(dir)
		return abs
	}
	if d := getenv("MEMORY_DIR"); d != "" {
		abs, _ := filepath.Abs(d)
		return abs
	}
	home := getenv("HOME")
	if home == "" {
		if u, err := user.Current(); err == nil {
			home = u.HomeDir
		}
	}
	return filepath.Join(home, ".agents", "memory")
}

func New(root string) *Bundle {
	abs, _ := filepath.Abs(root)
	return &Bundle{Root: abs}
}

func (b *Bundle) Abs(rel string) string { return filepath.Join(b.Root, filepath.FromSlash(rel)) }

func (b *Bundle) Exists() bool {
	_, err := os.Stat(b.Abs("index.md"))
	return err == nil
}

// Init creates the root, the gitignore, the root index and log when absent,
// runs git init when there is no repository and adds the remote when given
// and absent. Idempotent.
func (b *Bundle) Init(remote string, at time.Time) error {
	if err := os.MkdirAll(b.Root, 0o777); err != nil {
		return err
	}
	if err := b.EnsureGitignore(); err != nil {
		return err
	}
	if _, ok := b.Read("index.md"); !ok {
		if err := b.WriteAtomic("index.md", rootIndex); err != nil {
			return err
		}
	}
	if _, ok := b.Read("log.md"); !ok {
		d := js.ISO(at)[:10]
		if err := b.WriteAtomic("log.md", "# Directory Update Log\n\n## "+d+"\n* **Initialization**: Created the memory bundle.\n"); err != nil {
			return err
		}
	}
	if _, err := os.Stat(b.Abs(".git")); err != nil {
		if _, _, err := Git(b.Root, []string{"init", "-q", "-b", "main"}, false, 0); err != nil {
			return err
		}
	}
	if remote != "" && !HasRemote(b.Root) {
		if _, _, err := Git(b.Root, []string{"remote", "add", "origin", remote}, false, 0); err != nil {
			return err
		}
	}
	return nil
}

// EnsureGitignore writes the standard entries or adds *.tmp to an existing
// file that lacks it, so a temp file from a crashed write is never committed.
func (b *Bundle) EnsureGitignore() error {
	text, ok := b.Read(".gitignore")
	if !ok {
		return b.WriteAtomic(".gitignore", ".state/\n.locks/\n*.tmp\n")
	}
	for _, l := range strings.Split(text, "\n") {
		if strings.TrimSpace(l) == "*.tmp" {
			return nil
		}
	}
	if text == "" || strings.HasSuffix(text, "\n") {
		text += "*.tmp\n"
	} else {
		text += "\n*.tmp\n"
	}
	return os.WriteFile(b.Abs(".gitignore"), []byte(text), 0o666)
}

func (b *Bundle) Dir(projectID string) (Dir, error) {
	if projectID == "" {
		return Dir{Rel: "", Abs: b.Root, IsRoot: true}, nil
	}
	if _, err := AssertProjectID(projectID); err != nil {
		return Dir{}, err
	}
	rel := path.Join("projects", projectID)
	return Dir{Rel: rel, Abs: b.Abs(rel), IsRoot: false, ProjectID: projectID}, nil
}

// Dirs is the root plus every project directory under projects/: a
// directory counts when it holds a type directory or an index.md, else the
// walk descends. Sorted by rel with CompareFold.
func (b *Bundle) Dirs() ([]Dir, error) {
	root, _ := b.Dir("")
	out := []Dir{root}
	projects := b.Abs("projects")
	if _, err := os.Stat(projects); err != nil {
		return out, nil
	}
	var walk func(abs, rel string) error
	walk = func(abs, rel string) error {
		entries, err := os.ReadDir(abs)
		if err != nil {
			return err
		}
		var names []string
		for _, e := range entries {
			if e.IsDir() {
				names = append(names, e.Name())
			}
		}
		_, hasIndex := os.Stat(filepath.Join(abs, "index.md"))
		isProject := hasIndex == nil
		for _, n := range names {
			if slices.Contains(TypeDirOrder, n) {
				isProject = true
			}
		}
		if isProject {
			d, err := b.Dir(rel)
			if err != nil {
				return err
			}
			out = append(out, d)
			return nil
		}
		for _, n := range names {
			if err := walk(filepath.Join(abs, n), path.Join(rel, n)); err != nil {
				return err
			}
		}
		return nil
	}
	top, err := os.ReadDir(projects)
	if err != nil {
		return nil, err
	}
	for _, e := range top {
		if e.IsDir() {
			if err := walk(filepath.Join(projects, e.Name()), e.Name()); err != nil {
				return nil, err
			}
		}
	}
	slices.SortStableFunc(out, func(x, y Dir) int { return CompareFold(x.Rel, y.Rel) })
	return out, nil
}

func (b *Bundle) ConceptRel(dir Dir, typ, slug string) string {
	return path.Join(dir.Rel, DirForType(typ), slug+".md")
}

// WriteAtomic writes rel through a sibling temp file and a rename, so a
// reader never sees a partial file.
func (b *Bundle) WriteAtomic(rel, text string) error {
	abs := b.Abs(rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o777); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.%d.tmp", abs, os.Getpid(), time.Now().UnixMilli())
	if err := os.WriteFile(tmp, []byte(text), 0o666); err != nil {
		return err
	}
	if err := os.Rename(tmp, abs); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func (b *Bundle) Read(rel string) (string, bool) {
	raw, err := os.ReadFile(b.Abs(rel))
	if err != nil {
		return "", false
	}
	return string(raw), true
}

func (b *Bundle) WriteConcept(rel string, c *Concept) error {
	return b.WriteAtomic(rel, RenderConcept(c))
}

func (b *Bundle) ReadConcept(rel string) (*Concept, error) {
	text, ok := b.Read(rel)
	if !ok {
		return nil, Errorf(CodeNotFound, "%s", rel)
	}
	return ParseConcept(text)
}

// ListConcepts parses every .md under the directory's type directories,
// skipping files that fail to parse (Check reports them), sorted by rel.
func (b *Bundle) ListConcepts(dir Dir) ([]Entry, error) {
	var out []Entry
	for _, typeDir := range TypeDirOrder {
		abs := filepath.Join(dir.Abs, typeDir)
		entries, err := os.ReadDir(abs)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}
		for _, e := range entries {
			if !strings.HasSuffix(e.Name(), ".md") {
				continue
			}
			rel := path.Join(dir.Rel, typeDir, e.Name())
			text, ok := b.Read(rel)
			if !ok {
				continue
			}
			c, err := ParseConcept(text)
			if err != nil {
				continue
			}
			out = append(out, Entry{Rel: rel, Concept: c})
		}
	}
	slices.SortStableFunc(out, func(x, y Entry) int { return CompareFold(x.Rel, y.Rel) })
	return out, nil
}

func relTo(dirRel, rel string) string {
	if dirRel == "" {
		return rel
	}
	return strings.TrimPrefix(rel, dirRel+"/")
}

// FindConcept resolves a key that is a bundle rel, a directory-relative rel,
// or a bare slug; a bare slug matching more than one type directory is
// refused as ambiguous.
func (b *Bundle) FindConcept(dir Dir, key string) (Entry, error) {
	entries, err := b.ListConcepts(dir)
	if err != nil {
		return Entry{}, err
	}
	for _, e := range entries {
		if e.Rel == key || relTo(dir.Rel, e.Rel) == key {
			return e, nil
		}
	}
	var bare []Entry
	for _, e := range entries {
		if strings.HasSuffix(e.Rel, "/"+key+".md") || e.Rel == key+".md" {
			bare = append(bare, e)
		}
	}
	if len(bare) > 1 {
		var names []string
		for _, e := range bare {
			names = append(names, relTo(dir.Rel, e.Rel))
		}
		return Entry{}, Errorf(CodeRefused, "ambiguous key %s: %s", key, strings.Join(names, ", "))
	}
	if len(bare) == 1 {
		return bare[0], nil
	}
	where := dir.Rel
	if where == "" {
		where = "bundle root"
	}
	return Entry{}, Errorf(CodeNotFound, "no concept %s in %s", key, where)
}

func (b *Bundle) StatePath(name string) (string, error) {
	if err := os.MkdirAll(b.Abs(".state"), 0o777); err != nil {
		return "", err
	}
	return b.Abs(path.Join(".state", name)), nil
}

func requireBundle(b *Bundle) error {
	if !b.Exists() {
		return Errorf(CodeNotFound, "no bundle at %s; run memory init", b.Root)
	}
	return nil
}

// TargetDir is the CLI's targetDir: the root when root is set, else the
// project directory for cwd's repository.
func TargetDir(b *Bundle, cwd string, root bool) (Dir, error) {
	if err := requireBundle(b); err != nil {
		return Dir{}, err
	}
	if root {
		return b.Dir("")
	}
	id, err := ProjectIDFor(cwd)
	if err != nil {
		return Dir{}, err
	}
	return b.Dir(id)
}
