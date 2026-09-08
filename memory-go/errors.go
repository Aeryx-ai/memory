package memory

import (
	"errors"
	"fmt"
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
