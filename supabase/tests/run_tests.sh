#!/usr/bin/env bash
# Runs the hold/order tests against a local Postgres 16 (no Supabase needed).
# Usage: PGHOST=/path/to/socket PGPORT=5432 PGUSER=postgres ./run_tests.sh
set -euo pipefail
cd "$(dirname "$0")/.."
psql -qc 'drop database if exists bb_test' -c 'create database bb_test'
psql -d bb_test -q -v ON_ERROR_STOP=1 -f tests/stubs.sql -f schema.sql >/dev/null 2>&1
psql -d bb_test -q -v ON_ERROR_STOP=1 -f tests/holds_test.sql 2>&1 | grep -E '^psql:.*NOTICE:  ok|ALL HOLD TESTS PASSED|FAIL|ERROR' | sed 's/^psql:[^ ]* NOTICE:  //'
