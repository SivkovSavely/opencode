# Historical Admission Fence

This is an opt-in operator maintenance API for historical Session identities whose
projections and retirement tombstones have both been pruned. Ordinary
`POST /session/{sessionID}/retire` still returns 404 for an unknown, unproven root.
It never enrolls raw IDs automatically. No Session, message, or archived content is
recreated by maintenance enrollment.

## Authority And Authentication

Configure `OPENCODE_HISTORICAL_FENCE_PUBLIC_KEY` with a PEM-encoded Ed25519 public
key before starting the server. The key is read once when the handler layer is
built. An empty/unset value disables both maintenance operations (403). The
request cannot supply or select its verification key. Keep the private key with
the owner/operator who reviews archived ownership evidence, not with an ordinary
HTTP client. Normal configured HTTP authentication is also required; a valid
signature does not bypass it. Existing server deployments without configured HTTP
credentials retain their normal unauthenticated policy, so operators should
configure `OPENCODE_SERVER_PASSWORD` when enabling maintenance.

The trusted authority attests that it verified archived ownership evidence. The
server verifies this authority's signature and binding, not the truth or contents
of the archive. A client receipt, raw root ID, self-signed claim, or unrelated
database record is not independently reconstructed ownership evidence. If no
trusted authority can establish ownership, do not enroll the identity or claim a
permanent fence.

## Operations

Both routes use the existing `directory` / `workspace` query and routing context:

- `GET /maintenance/historical-fence/identity` returns `databaseID`, `projectID`,
  canonical `directory`, and nullable `workspaceID` for signing. It does not expose
  the SQLite filename. `databaseID` is a random persistent logical database
  identity; a byte-for-byte database backup retains that identity, while a newly
  initialized database gets a different identity.
- `POST /maintenance/historical-fence` accepts `{ attestation, signature }`.
  `signature` is standard padded base64 of a detached Ed25519 signature over the
  UTF-8 canonical payload below. This operation is local database maintenance,
  not an orchestration/workqueue cleanup operation.

Canonical payload fields, in exact order:

```json
{
  "version": 1,
  "databaseID": "value from identity operation",
  "projectID": "value from identity operation",
  "directory": "/canonical/workspace",
  "workspaceID": null,
  "rootSessionID": "ses_verified_root",
  "members": [{ "sessionID": "ses_verified_root", "parentSessionID": null, "role": "root" }],
  "membershipCoverage": "attested-partial",
  "artifact": { "reference": "archive:reviewed-ownership-record", "sha256": "64 lowercase hexadecimal characters" },
  "issuer": "reviewing owner/operator",
  "issuedAt": 1793404800000,
  "nonce": "unique per signing key"
}
```

Canonical encoding is `JSON.stringify` of an object built in precisely the field
order shown, without whitespace or a trailing newline. Nested member fields are
ordered `sessionID`, `parentSessionID`, `role`; artifact fields are ordered
`reference`, `sha256`. `HistoricalFence.canonical` is the server implementation.
Members must be unique, strictly ascending by session ID, and number 1 through 1000. The exact root must appear once with role `root` and null parent; every
other listed member has role `descendant` and a nonnull listed parent. Every
descendant's acyclic parent chain must reach the declared root. Unknown ancestry
does not authorize inventing edges: submit a root-only attestation when only the
root is supported. List
only members supported by the reviewed evidence. Missing historical descendants
are not synthesized and coverage is always explicitly partial.

The artifact digest is SHA-256 of the exact reviewed archive artifact bytes.
The reference identifies those bytes for audit; the server does not fetch it.
`issuedAt` is a nonnegative safe-integer Unix timestamp in milliseconds and must
not be in the future. Issuer, nonce, reference, and all session IDs must be
nonempty. There is no expiry window that would break an exact retry after a
long outage. The nonce cannot be reused under the same signer for another root.

The server denies invalid signatures, other database/project/directory/workspace
bindings, future issuance, malformed membership, existing conflicting
projection/execution ancestry, previously retired listed identities, and
conflicting root/nonce replays. Exact retries of the same signed attestation are
accepted before conflict checks and return the original immutable proof. A key
rotation does not permit old signatures unless that key is configured again.

## Durable Result

Enrollment transactionally writes the canonical payload, its SHA-256, signer
SPKI SHA-256 fingerprint, signature, issuer, nonce, original recording time, exact
listed membership, and permanent tombstones. In the same immediate transaction,
it traverses current projected/runtime descendants of the attested set, prior
durable membership, and command-only identities retained by `managed_command`
for this root, checks project/directory/workspace and ancestry
ownership (including conflicting durable command roots), fences every observed
member, and revokes their runtime generations.
Conflicting observed ownership rejects the entire enrollment without evidence,
tombstones, or runtime changes. This durable fence does not depend on the handler
reaching its later local cancellation request: a disconnect immediately after
commit cannot leave a known grandchild admissible or recoverable.

The evidence row's separate immutable `observed_payload` records the database
snapshot with source `database-during-enrollment` and coverage `observed-partial`.
It is not part of the operator-signed canonical payload or its hash; exact retry
retains both original payloads without recomputing or expanding the signed set.
The maintenance response still lists exactly the signed attested members. Neither
snapshot nor signature implies complete historical membership or cleanup.
Evidence and database identity
reject SQL updates/deletes. Tombstones are independent of projection/execution
foreign-key cascades. Existing admission, queue, recovery, notification, and
same-ID insertion guards consume the same retirement fence. Local runtime
retirement/cancellation is requested after persistence; retries repair a request
that was disconnected after committing the fence.

The response contains `rootSessionID`, exact attested `sessionIDs`, `evidenceHash`,
`recordedAt`, `signer`, `membershipCoverage: "attested-partial"`,
`admissionFence: "permanent"`, `historicalCleanup: "unknown"`, and
`commandStatus: "unknown"`. Exact repeated POSTs retrieve the original proof even
after restart or projection pruning. Ordinary retirement can subsequently return
200 with durable membership and unknown command status, plus explicit
`membershipCoverage`, `historicalCleanup`, and `evidenceHash` fields for attested or observed-pruned
roots. Its durable membership may also include descendants subsequently observed
from actual database ancestry; the exact signed set remains in the maintenance
proof. Permanent admission
denial is not proof that historical commands, escaped processes, plugins, remote
work, or every possible historical descendant have terminated. Consumers must
not treat this partial member list as complete cleanup coverage.

## Future Pruning

`Session.remove` validates the entire currently observed root or child subtree
before deleting any descendant. Validation, retirement, and recursive durable
deletion share one immediate transaction, preventing ownership changes between
validation and pruning. Deleted events are recorded/projected in child-before-parent
order inside that transaction, and their event-store rows are removed there as
before. Listener, SSE, and share notifications are dispatched in the same order
only after successful commit, never for a rolled-back prune, and never while
holding its database connection. Background jobs are cancelled and joined after
commit, before notifications, so their database-using finalizers cannot deadlock
against the pruning transaction or be skipped by a failed notification.
The database prune, post-commit cancellation join, and notification dispatch are
uninterruptible by the caller: aborting a request cannot strand jobs or skip
committed deletion notifications. Cancellation also joins jobs whose status has
already changed while their scope finalizers are still running. Notification
failure cannot skip the preceding cleanup join. Process loss or listener failure
can still omit notifications; deletion does not provide a durable notification
outbox or retry a missing projection.
Conflicting
projected/runtime parents reject removal before any permanent membership or
tombstone is written; ordinary retirement semantics are unchanged. Independently deleting a projected child retains its
observed root membership and fences that deleted subtree without retiring the
live root or siblings. A database trigger records known root ownership and observed projected/execution
descendants before deleting an extant root projection, and installs their
retirement tombstones in that deletion transaction. Both child and root prune
triggers also cancel every observed runtime generation, clear desired activity
and retry deadlines, and advance its fence before execution ancestry can cascade
away. A descendant with a surviving projection but only runtime ancestry into the
deleted subtree cannot continue its old provider turn or command dispatch.
Previously recorded immutable membership of an already permanently fenced
identity is preserved, including membership shared by retired roots; it is not a
new attribution of an unfenced identity. Conflicting ownership of unfenced or
newly observed members still rejects the entire prune.
It does not call the signed
authority path or manufacture signed evidence. Immutable `historical_fence_prune`
payloads bind the database/project/directory/workspace and label membership
`observed-partial`. A projected root with a known execution parent is not treated
as a historical root. Already-pruned descendants and roots are not retroactively
reconstructed. These records prove observed identity and admission denial, not
historical process cleanup. They do not authorize recreating a Session.
Both direct runtime status and HTTP retirement report `unknown` for these
partial records, even if subsequently observed managed commands have confirmed
cleanup. The HTTP response labels coverage `observed-partial` and hashes the
immutable observed payload; that hash is not an operator signature.

Child pruning follows both projected and runtime ancestry before execution rows
cascade away, including projected roots that are runtime children. It requires
one observed root and rejects deletion when any traversed Session has conflicting
nonnull projected/runtime parents, or no unique root can be established. Such a
rejection leaves projections, execution ancestry, and retirement state unchanged;
it does not select an arbitrary owner or retire either possible parent. Already
fenced identities need no new ancestry inference during subsequent deletion.
Both root and child pruning also validate every affected descendant before
assigning ownership. A projected descendant with a different runtime parent is
not silently enrolled under either root. Root deletion may retain an already
durably recorded and fenced membership without inferring a new owner from that
conflict.
