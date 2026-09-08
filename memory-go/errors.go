package memory

import (
	"errors"
	"fmt"
	"time"
)

type Code string

const (
	CodeUsage    Code = "usage"
	CodeNotFound Code = "notfound"
	CodeRefused  Code = "refused"
	CodeCheck    Code = "check"
	CodeSync     Code = "sync"
)

// Error is the one error type the SDK returns for a refused invariant, a
// missing concept, a failed check or a failed sync. Anything else is an
// unexpected condition (I/O, git) and is returned as is.
type Error struct {
	Code    Code
	Message string
}

func (e *Error) Error() string { return e.Message }

func Errorf(code Code, format string, a ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, a...)}
}

var exitCodes = map[Code]int{CodeUsage: 1, CodeNotFound: 2, CodeRefused: 3, CodeCheck: 4, CodeSync: 5}

func ExitCode(code Code) int {
	if n, ok := exitCodes[code]; ok {
		return n
	}
	return 1
}

// CodeOf returns the Code of err when it is (or wraps) an *Error, else "".
func CodeOf(err error) Code {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// requireAt refuses a zero time.Time: every stamping function takes now from
// its caller (nothing calls time.Now() outside the lock and temp names), so a
// zero value is always a bug at the call site, never a legitimate timestamp.
func requireAt(at time.Time) error {
	if at.IsZero() {
		return Errorf(CodeUsage, "at is required")
	}
	return nil
}

// requireNow is requireAt's message for FoldOptions.Now.
func requireNow(now time.Time) error {
	if now.IsZero() {
		return Errorf(CodeUsage, "Now is required")
	}
	return nil
}
