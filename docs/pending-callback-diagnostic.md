# Pending callback failures and late completion checks

A callback can establish a finite `invalid` result while its original command
budget is still live. Its later mutation-lock or parent-directory check may then
observe the deadline. That observation must not erase the already-returned
failure. The previous implementation preserved the callback failure only when
the first budget observation after the callback was already stopped, leaving a
later postcondition window uncovered.

Keep the returned `invalid` result as a separate local fact through completion.
If a post-callback check throws the actual command's typed budget stop, return
that established failure while the same budget retains its stop reason. Admit
no additional check or mutation after that stop; the `finally` block still
closes the already-owned lock descriptor. This is not evidence that the callback
had no earlier effects or that a failed or unacknowledged mutation rolled back.

A successful callback continues through every existing lock, directory and
budget postcondition and cannot become a late success. A budget error before
any callback result is returned cannot manufacture a rejection. A non-budget
completion error retains the previous finite store-failure path; it is not
converted into a clock stop or used to claim that a success was verified.
Nothing changes the cleanup intent, receipt, TTL, generation, locking procedure,
request quota or deadline.

Tests preserve the original real-file/flock four-case counterexample and add
finite completion-boundary controls. They use authored GIFs and a modeled
monotonic clock around actual descriptor, lock and directory operations, with no
real API or production state. Existing resource bytes and generation must stay
unchanged in conflict scenarios; after a stop only closure of already-owned
descriptors is allowed. Normal clock, time-budget, clock-unavailable, successful
callback, not-yet-returned callback and non-budget completion failures remain
separate outcomes.
