// Package ordering classifies correlated assessment revisions.
package ordering

const (
	New       = "NEW"
	Duplicate = "DUPLICATE"
	Obsolete  = "OBSOLETE"
)

func Classify(exactRevisionSeen bool, latestRevision, incomingRevision int64) string {
	if exactRevisionSeen {
		return Duplicate
	}
	if incomingRevision <= latestRevision {
		return Obsolete
	}
	return New
}
