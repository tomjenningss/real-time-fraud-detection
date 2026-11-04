#!/bin/sh
# Read-only prerequisite report.  This script must stay free of mutating oc commands.
set -eu

need() {
  if ! "$@"; then
    echo "Gate 0 failed: $*" >&2
    exit 1
  fi
}

can() {
  answer=$(oc auth can-i "$1" "$2" ${3:+"$3"})
  if [ "$answer" != "yes" ]; then
    echo "Gate 0 failed: cannot $1 $2 ${3:-}" >&2
    exit 1
  fi
}

need oc version
need oc whoami
need oc project
can create statefulsets.apps
can create persistentvolumeclaims
can create routes.route.openshift.io
can create jobs.batch
need oc get resourcequota
need oc get limitrange
need oc get nodes -o custom-columns=NAME:.metadata.name,CPU:.status.allocatable.cpu,MEMORY:.status.allocatable.memory
need oc get storageclass
need oc get route -A
need oc get scc restricted-v2
need oc auth can-i get imagestreams.image.openshift.io

echo "Gate 0 passed: review this report before rendering or applying deployment resources."
