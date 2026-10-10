# Security fork

Upstream: braces 3.0.3 (MIT, LICENSE included). GHSA-vfj7-8cjw-p6xm has no upstream patched release as of 2026-10-08. This fork rejects pattern nesting above 64 before parsing and bounds public AST walkers to 64 levels / 65536 nodes with cycle detection. Ordinary clasp ignore patterns retain upstream behavior. The version suffix identifies this local patch, not an upstream release. Remove the override after an upstream fix is available. Regression tests exercise the installed dependency, direct AST inputs, and micromatch.
