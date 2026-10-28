package ordering

import "testing"

func TestDuplicateAndOutOfOrderRevisions(t *testing.T) {
	tests := []struct {
		name             string
		exact            bool
		latest, incoming int64
		want             string
	}{
		{"first", false, 0, 1, New},
		{"updated", false, 1, 2, New},
		{"duplicate", true, 2, 2, Duplicate},
		{"obsolete unseen", false, 4, 2, Obsolete},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Classify(tt.exact, tt.latest, tt.incoming); got != tt.want {
				t.Fatalf("got %s, want %s", got, tt.want)
			}
		})
	}
}
