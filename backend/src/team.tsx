import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Select } from "../../src/ui";
import ConfirmDialog from "../../src/ConfirmDialog";

interface Usage {
  meetingMsUsed: number;
  meetingMsReserved: number;
  briefsUsed: number;
  briefsReserved: number;
  meetingMsTotal: number;
  briefsTotal: number;
  endsMs: number | null;
}
interface Seat {
  id: string;
  number: number;
  status: string;
  accountId: string | null;
  usage: Usage;
}
interface Member {
  accountId: string;
  role: string;
  email: string | null;
}
interface Invitation {
  id: string;
  email: string;
  expiresMs: number;
  deliveryState: string;
  assignSeat: boolean;
}
interface Organization {
  id: string;
  name: string;
  role: string;
  assignment: {
    id: string;
    seatId: string;
    seatNumber: number;
    allowance: Usage;
  } | null;
  paidCapacity?: number;
  seats?: Seat[];
  members?: Member[];
  invitations?: Invitation[];
  subscription?: {
    status: string;
    quantityNext: number;
    paidThroughMs: number | null;
    cancelAtPeriodEnd: number;
    externalChange: number;
  } | null;
  pendingCheckout?: { id: string; quantity: number; state: string } | null;
  pendingQuantityChange?: { quantity: number; state: string } | null;
}
interface Summary {
  catalog: {
    monthly: {
      amountCents: number;
      currency: string;
      hours: number;
      briefs: number;
    };
  };
  teamPurchaseEnabled: boolean;
  organization: Organization | null;
  identity: { issuer: string; subject: string; email: string | null };
}
class TeamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new TeamError(
      data.message ?? "Could not update your team. Try again.",
      response.status,
    );
  return data as T;
}
const inviteKey = "savvy.invite";
function readInvitation() {
  const raw = location.hash.slice(1);
  if (raw) {
    history.replaceState(null, "", location.pathname + location.search);
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) {
      sessionStorage.removeItem(inviteKey);
      return null;
    }
    sessionStorage.setItem(
      inviteKey,
      JSON.stringify({ token: raw, expiresAt: Date.now() + 3_600_000 }),
    );
  }
  try {
    const stored = JSON.parse(sessionStorage.getItem(inviteKey) ?? "null");
    if (
      stored &&
      /^[A-Za-z0-9_-]{43}$/.test(stored.token) &&
      stored.expiresAt > Date.now()
    )
      return stored.token as string;
  } catch {
    /* A corrupt local draft cannot authorize an invitation. */
  }
  sessionStorage.removeItem(inviteKey);
  return null;
}
function date(value: number | null | undefined) {
  return value ? new Date(value).toLocaleDateString() : "not yet confirmed";
}
function hours(value: number) {
  return (value / 3_600_000).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  });
}
function purchaseKey(summary: Summary, kind: string) {
  return `savvy.team.${kind}:${summary.identity.issuer}:${summary.identity.subject}:${summary.organization!.id}`;
}
function requestKey(key: string, body: unknown) {
  const previous = sessionStorage.getItem(key),
    encoded = JSON.stringify(body);
  if (previous) {
    const stored = JSON.parse(previous);
    if (stored.body !== encoded)
      throw new TeamError(
        "An earlier change is still pending. Refresh and retry its original quantity.",
        409,
      );
    return stored.key as string;
  }
  const created = crypto.randomUUID();
  sessionStorage.setItem(key, JSON.stringify({ key: created, body: encoded }));
  return created;
}
function SeatRow({
  seat,
  members,
  occupied,
  busy,
  assign,
  unassign,
}: {
  seat: Seat;
  members: Member[];
  occupied: Set<string>;
  busy: boolean;
  assign: (member: string) => void;
  unassign: () => void;
}) {
  const [selected, setSelected] = useState("");
  const available = members.filter((member) => !occupied.has(member.accountId));
  const holder = members.find((member) => member.accountId === seat.accountId);
  return (
    <tr>
      <th scope="row">
        {seat.number}
        <small>{seat.status !== "active" ? seat.status : ""}</small>
      </th>
      <td>
        {seat.accountId
          ? (holder?.email ?? `Member ${seat.accountId}`)
          : "Unassigned"}
      </td>
      <td>
        {hours(seat.usage.meetingMsUsed)} / {hours(seat.usage.meetingMsTotal)}{" "}
        hours
        <br />
        {seat.usage.briefsUsed} / {seat.usage.briefsTotal} briefs
      </td>
      <td>
        {seat.accountId ? (
          <Button
            disabled={busy}
            onClick={unassign}
            aria-label={`Unassign seat ${seat.number}`}
          >
            Unassign
          </Button>
        ) : seat.status === "active" && seat.usage.endsMs !== null ? (
          <>
            <Select
              label={`Assign member to seat ${seat.number}`}
              selectedValue={selected}
              disabled={busy || available.length === 0}
              onSelect={setSelected}
              options={[
                { value: "", label: "Choose member", disabled: true },
                ...available.map((member) => ({
                  value: member.accountId,
                  label: member.email ?? `Member ${member.accountId}`,
                })),
              ]}
            />
            <Button
              disabled={
                busy || !available.some((m) => m.accountId === selected)
              }
              onClick={() => assign(selected)}
              aria-label={`Assign seat ${seat.number}`}
            >
              Assign
            </Button>
          </>
        ) : (
          <span>Unavailable</span>
        )}
      </td>
    </tr>
  );
}
export function Team({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const join = location.pathname === "/team/join";
  const [invite, setInvite] = useState(() => (join ? readInvitation() : null));
  const [summary, setSummary] = useState<Summary | null>(null),
    [loading, setLoading] = useState(true),
    [needsSignIn, setNeedsSignIn] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [joined, setJoined] = useState(false);
  const [name, setName] = useState(""),
    [quantity, setQuantity] = useState("2"),
    [nextQuantity, setNextQuantity] = useState<string | null>(null),
    [retiring, setRetiring] = useState<string[]>([]),
    [email, setEmail] = useState(""),
    [autoAssign, setAutoAssign] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    confirm: string;
    action: () => Promise<unknown>;
  } | null>(null);
  const pending = useRef(false),
    initial = useRef(false);
  const refresh = useCallback(async () => {
    const value = await api<Summary>("/v1/org");
    setSummary(value);
    setNeedsSignIn(false);
    sessionStorage.removeItem("savvy.returnTo");
    if (value.organization) {
      if (!value.organization.pendingCheckout)
        sessionStorage.removeItem(purchaseKey(value, "checkout"));
      if (!value.organization.pendingQuantityChange)
        sessionStorage.removeItem(purchaseKey(value, "quantity"));
    }
    return value;
  }, []);
  const accept = useCallback(
    async (token: string) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setError("");
      try {
        const result = await api<{ seat: boolean }>(
          "/v1/org/invitations/accept",
          { token },
        );
        const stored = JSON.parse(sessionStorage.getItem(inviteKey) ?? "null");
        if (stored?.token === token) sessionStorage.removeItem(inviteKey);
        setInvite((current) => (current === token ? null : current));
        setJoined(true);
        setMessage(
          result.seat
            ? "Your seat is assigned."
            : "The owner will assign a seat.",
        );
        await refresh();
      } catch (caught) {
        if (caught instanceof TeamError && caught.status === 401)
          setNeedsSignIn(true);
        else if (
          caught instanceof TeamError &&
          [400, 403, 422].includes(caught.status)
        ) {
          const stored = JSON.parse(
            sessionStorage.getItem(inviteKey) ?? "null",
          );
          if (stored?.token === token) sessionStorage.removeItem(inviteKey);
          setInvite((current) => (current === token ? null : current));
        }
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not accept the invitation. Retry below.",
        );
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [refresh],
  );
  useEffect(() => {
    if (initial.current) return;
    initial.current = true;
    void (async () => {
      try {
        await refresh();
        if (join && invite) await accept(invite);
      } catch (caught) {
        if (caught instanceof TeamError && caught.status === 401)
          setNeedsSignIn(true);
        else
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not load your team.",
          );
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh, join, invite, accept]);
  useEffect(() => {
    if (!join) return;
    const changed = () => {
      if (!location.hash) return;
      const token = readInvitation();
      setInvite(token);
      setJoined(false);
      setMessage("");
      if (!token) {
        setError(
          "This invitation link is invalid. Open the link from your email.",
        );
        return;
      }
      void refresh()
        .then(() => accept(token))
        .catch((caught) => {
          if (caught instanceof TeamError && caught.status === 401)
            setNeedsSignIn(true);
          else
            setError(
              caught instanceof Error
                ? caught.message
                : "Could not load the invitation.",
            );
        });
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [join, refresh, accept]);
  async function run(action: () => Promise<unknown>) {
    if (pending.current || busy) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      if (result !== false) await refresh();
    } catch (caught) {
      if (caught instanceof TeamError && caught.status === 401)
        setNeedsSignIn(true);
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not update your team.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function confirm(
    title: string,
    description: string,
    label: string,
    action: () => Promise<unknown>,
  ) {
    setError("");
    setConfirmation({ title, description, confirm: label, action });
  }
  const org = summary?.organization,
    owner = org?.role === "owner",
    seats = org?.seats ?? [],
    members = org?.members ?? [],
    occupied = new Set(
      seats.flatMap((seat) => (seat.accountId ? [seat.accountId] : [])),
    );
  const offer = summary?.catalog.monthly;
  const currency = (count: number) =>
    offer
      ? new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: offer.currency,
        }).format((offer.amountCents * count) / 100)
      : "";
  const quantityValue = Number(
    nextQuantity ??
      org?.subscription?.quantityNext ??
      seats.filter((s) => s.status !== "retired").length,
  );
  const retireCount = Math.max(
    0,
    seats.filter((s) => s.status !== "retired").length - quantityValue,
  );
  const signIn = `/sign-in?returnTo=${encodeURIComponent(join ? "/team/join" : "/team")}`;
  return (
    <main className="team-page">
      <strong className="wordmark">savvy</strong>
      <h1>
        {joined && org
          ? `You joined ${org.name}`
          : org
            ? org.name
            : join
              ? "Join your team"
              : "Your Savvy team"}
      </h1>
      {error && !confirmation && <Alert>{error}</Alert>}
      {message && <Alert variant="success">{message}</Alert>}
      {loading ? (
        <p role="status">Loading your team…</p>
      ) : needsSignIn ? (
        <section className="account-card">
          <p>
            {join
              ? "Sign in with the invited email address to join your team."
              : "Sign in to buy and manage seats for your organization."}
          </p>
          <a className="button" href={signIn}>
            Sign in
          </a>
          <p>
            Each person keeps their own Savvy account, documents, connected
            sources and call history.
          </p>
        </section>
      ) : summary ? (
        <>
          <div className="team-toolbar">
            <span>
              Signed in as {summary.identity.email ?? "your Savvy account"}
            </span>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await refresh();
                  return false;
                })
              }
            >
              Refresh
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await onSignOut();
                  return false;
                })
              }
            >
              Sign out
            </Button>
          </div>
          {!summary.teamPurchaseEnabled && (
            <Alert variant="info">
              New team purchases and invitations are currently unavailable.
              Existing seats and invitations keep working.
            </Alert>
          )}
          {invite && join && !joined && (
            <Button disabled={busy} onClick={() => void accept(invite)}>
              Retry joining team
            </Button>
          )}
          {!org ? (
            join ? (
              <section className="account-card">
                <p>Open the invitation link from your email to join a team.</p>
                <a href="/team">Manage your own team</a>
              </section>
            ) : (
              <section className="account-card">
                <h2>Create your organization</h2>
                <p>
                  One invoice, individual seats. Each seat includes{" "}
                  {offer?.hours} meeting hours and {offer?.briefs} briefs per
                  paid month.
                </p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await api("/v1/org", { name });
                    });
                  }}
                >
                  <label htmlFor="team-name">Organization name</label>
                  <Input
                    id="team-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={120}
                    disabled={busy}
                  />
                  <Button
                    variant="primary"
                    type="submit"
                    disabled={busy || !summary.teamPurchaseEnabled}
                  >
                    Create organization
                  </Button>
                </form>
              </section>
            )
          ) : (
            <>
              {org.assignment ? (
                <section className="account-card">
                  <h2>Your seat</h2>
                  <p>
                    Seat {org.assignment.seatNumber}.{" "}
                    {hours(org.assignment.allowance.meetingMsUsed)} of{" "}
                    {hours(org.assignment.allowance.meetingMsTotal)} hours and{" "}
                    {org.assignment.allowance.briefsUsed} of{" "}
                    {org.assignment.allowance.briefsTotal} briefs used. Paid
                    through {date(org.assignment.allowance.endsMs)}.
                  </p>
                </section>
              ) : (
                <Alert variant="info">
                  You are in {org.name} without a seat.{" "}
                  {owner
                    ? "Assign yourself a paid seat below if you want to use Savvy through the team."
                    : "Ask the owner to assign you a seat."}
                </Alert>
              )}
              <p>
                Download Savvy for{" "}
                <a href="https://github.com/jamalavedra/savvy/releases/latest">
                  macOS or Windows
                </a>
                , sign in with {summary.identity.email ?? "this account"}, and
                choose your organization in Settings to use your seat. Personal
                credit stays separate.
              </p>
              {owner && (
                <>
                  <section className="account-card">
                    <h2>Team billing</h2>
                    <p>
                      {org.paidCapacity ?? 0} seats paid through{" "}
                      {date(org.subscription?.paidThroughMs)}
                      {org.subscription
                        ? `; next period ${org.subscription.quantityNext} seats.`
                        : "."}
                    </p>
                    {org.subscription?.cancelAtPeriodEnd ? (
                      <Alert variant="warning">
                        Your subscription will end after the paid period.
                      </Alert>
                    ) : null}
                    {org.subscription?.externalChange ? (
                      <Alert variant="warning">
                        A change was detected in Stripe. Review the next-period
                        quantity and retiring seats.
                      </Alert>
                    ) : null}
                    {org.pendingCheckout ? (
                      <>
                        <Alert variant="info">
                          Payment is{" "}
                          {org.pendingCheckout.state.replaceAll("_", " ")}.
                          Returning from checkout does not confirm payment.
                        </Alert>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const result = await api<{ url?: string }>(
                                "/v1/org/checkout",
                                { resumeId: org.pendingCheckout!.id },
                              );
                              if (result.url) {
                                location.assign(result.url);
                                return false;
                              }
                              setMessage(
                                "Payment is reconciling. Refresh to check its status.",
                              );
                            })
                          }
                        >
                          Continue pending checkout
                        </Button>
                      </>
                    ) : !org.subscription ||
                      ["canceled", "incomplete_expired"].includes(
                        org.subscription.status,
                      ) ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          void run(async () => {
                            const amount = Number(quantity);
                            const key = requestKey(
                              purchaseKey(summary, "checkout"),
                              { quantity: amount },
                            );
                            const result = await api<{ url?: string }>(
                              "/v1/org/checkout",
                              { quantity: amount, requestKey: key },
                            );
                            if (result.url) {
                              location.assign(result.url);
                              return false;
                            }
                            setMessage(
                              "Payment is reconciling. Refresh to check its status.",
                            );
                          });
                        }}
                      >
                        <label htmlFor="team-seats">Seats to buy</label>
                        <Input
                          id="team-seats"
                          type="number"
                          min={1}
                          max={50}
                          step={1}
                          required
                          value={quantity}
                          onChange={(event) => setQuantity(event.target.value)}
                          disabled={busy}
                        />
                        <p>
                          {currency(Number(quantity) || 0)} per month,{" "}
                          {currency(1)} per seat. The owner does not need a
                          seat.
                        </p>
                        <Button
                          variant="primary"
                          type="submit"
                          disabled={busy || !summary.teamPurchaseEnabled}
                        >
                          Continue to checkout
                        </Button>
                      </form>
                    ) : null}
                    {org.subscription && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const result = await api<{ url: string }>(
                              "/v1/org/portal",
                              {},
                            );
                            location.assign(result.url);
                            return false;
                          })
                        }
                      >
                        Manage billing
                      </Button>
                    )}
                  </section>
                  <section className="account-card">
                    <h2>Seats</h2>
                    <div
                      className="team-table"
                      tabIndex={0}
                      role="region"
                      aria-label="Team seats"
                    >
                      <table>
                        <caption>Assignment and current-period usage</caption>
                        <thead>
                          <tr>
                            <th>Seat</th>
                            <th>Member</th>
                            <th>Usage</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {seats.map((seat) => (
                            <SeatRow
                              key={seat.id}
                              seat={seat}
                              members={members}
                              occupied={occupied}
                              busy={busy}
                              assign={(accountId) =>
                                void run(async () => {
                                  await api(`/v1/org/seats/${seat.id}/assign`, {
                                    accountId,
                                  });
                                  setMessage(`Seat ${seat.number} assigned.`);
                                })
                              }
                              unassign={() =>
                                confirm(
                                  "Unassign this seat?",
                                  "Any meeting using this team seat will stop. The member keeps their private data and personal credit.",
                                  "Unassign",
                                  () =>
                                    api(
                                      `/v1/org/seats/${seat.id}/unassign`,
                                      {},
                                    ),
                                )
                              }
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {seats.length === 0 && (
                      <p>Seats appear after payment is confirmed.</p>
                    )}
                    {org.subscription &&
                      !["canceled", "incomplete_expired"].includes(
                        org.subscription.status,
                      ) && (
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            void run(async () => {
                              const ids = retireCount
                                ? retiring
                                    .slice()
                                    .sort((a, b) =>
                                      BigInt(a) < BigInt(b)
                                        ? -1
                                        : BigInt(a) > BigInt(b)
                                          ? 1
                                          : 0,
                                    )
                                : [];
                              if (ids.length !== retireCount)
                                throw new Error(
                                  `Choose exactly ${retireCount} vacant seats to retire.`,
                                );
                              const body = {
                                quantity: quantityValue,
                                retireSeatIds: ids,
                              };
                              const key = requestKey(
                                purchaseKey(summary, "quantity"),
                                body,
                              );
                              await api("/v1/org/seats", {
                                ...body,
                                requestKey: key,
                              });
                              setMessage(
                                "Seat quantity scheduled for the next paid renewal.",
                              );
                            });
                          }}
                        >
                          <label htmlFor="next-seats">Seats next period</label>
                          <Input
                            id="next-seats"
                            type="number"
                            required
                            min={1}
                            max={50}
                            step={1}
                            value={
                              nextQuantity ??
                              String(org.subscription.quantityNext)
                            }
                            onChange={(event) =>
                              setNextQuantity(event.target.value)
                            }
                            disabled={busy}
                          />
                          <p>
                            Changes take effect at the next paid renewal. New
                            seats become available only after that invoice is
                            paid.
                          </p>
                          {retireCount > 0 && (
                            <fieldset>
                              <legend>
                                Choose {retireCount} vacant seats to retire
                              </legend>
                              {seats
                                .filter((seat) => seat.status !== "retired")
                                .map((seat) => (
                                  <label
                                    className="checkbox-label"
                                    key={seat.id}
                                  >
                                    <Input
                                      type="checkbox"
                                      checked={retiring.includes(seat.id)}
                                      disabled={busy || seat.accountId !== null}
                                      onChange={(event) =>
                                        setRetiring((current) =>
                                          event.target.checked
                                            ? [...current, seat.id]
                                            : current.filter(
                                                (id) => id !== seat.id,
                                              ),
                                        )
                                      }
                                    />
                                    Seat {seat.number}
                                    {seat.accountId ? " (assigned)" : ""}
                                  </label>
                                ))}
                            </fieldset>
                          )}
                          {org.pendingQuantityChange && (
                            <Alert variant="info">
                              A change to {org.pendingQuantityChange.quantity}{" "}
                              seats is reconciling. Refresh before submitting a
                              different change.
                            </Alert>
                          )}
                          <Button type="submit" disabled={busy}>
                            Schedule quantity change
                          </Button>
                        </form>
                      )}
                  </section>
                  <div className="team-grid">
                    <section className="account-card">
                      <h2>Invite a member</h2>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          void run(async () => {
                            const result = await api<{ deliveryState: string }>(
                              "/v1/org/invitations",
                              { email, assignSeat: autoAssign },
                            );
                            setEmail("");
                            setMessage(
                              result.deliveryState === "sent"
                                ? "Invitation sent. It expires in 7 days."
                                : "Email delivery failed. Use Resend below to try again.",
                            );
                          });
                        }}
                      >
                        <label htmlFor="invite-email">Member email</label>
                        <Input
                          id="invite-email"
                          type="email"
                          required
                          maxLength={254}
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                          disabled={busy}
                        />
                        <label className="checkbox-label">
                          <Input
                            type="checkbox"
                            checked={autoAssign}
                            disabled={busy}
                            onChange={(event) =>
                              setAutoAssign(event.target.checked)
                            }
                          />
                          Assign a free paid seat when they join
                        </label>
                        <p>Invitations do not reserve seats.</p>
                        <Button
                          variant="primary"
                          type="submit"
                          disabled={busy || !summary.teamPurchaseEnabled}
                        >
                          Send invitation
                        </Button>
                      </form>
                      {org.invitations?.map((invitation) => (
                        <div className="team-item" key={invitation.id}>
                          <strong>{invitation.email}</strong>
                          <small>
                            {invitation.deliveryState}, expires{" "}
                            {date(invitation.expiresMs)}
                          </small>
                          <Button
                            disabled={busy || !summary.teamPurchaseEnabled}
                            onClick={() =>
                              void run(() =>
                                api(
                                  `/v1/org/invitations/${invitation.id}/resend`,
                                  {},
                                ),
                              )
                            }
                          >
                            Resend
                          </Button>
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void run(() =>
                                api(
                                  `/v1/org/invitations/${invitation.id}/revoke`,
                                  {},
                                ),
                              )
                            }
                          >
                            Revoke invitation
                          </Button>
                        </div>
                      ))}
                    </section>
                    <section className="account-card">
                      <h2>Members</h2>
                      {members.map((member) => (
                        <div className="team-item" key={member.accountId}>
                          <strong>
                            {member.email ?? `Member ${member.accountId}`}
                          </strong>
                          <small>{member.role}</small>
                          {member.role !== "owner" && (
                            <>
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  confirm(
                                    "Remove this member?",
                                    "Their team-funded work will stop. Their personal credit, recordings and documents remain theirs.",
                                    "Remove member",
                                    () =>
                                      api(
                                        `/v1/org/members/${member.accountId}/remove`,
                                        {},
                                      ),
                                  )
                                }
                              >
                                Remove member
                              </Button>
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  confirm(
                                    "Transfer ownership?",
                                    "This member will manage the team subscription, invitations and seats. You will become a member.",
                                    "Transfer ownership",
                                    () =>
                                      api("/v1/org/transfer-owner", {
                                        accountId: member.accountId,
                                      }),
                                  )
                                }
                              >
                                Transfer ownership
                              </Button>
                            </>
                          )}
                        </div>
                      ))}
                    </section>
                  </div>
                </>
              )}
              {!owner && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    confirm(
                      "Leave this team?",
                      "Your team-funded work will stop. Your personal data and credit stay with you.",
                      "Leave team",
                      () => api("/v1/org/leave", {}),
                    )
                  }
                >
                  Leave team
                </Button>
              )}
              <p>
                Team owners see membership, seats and usage totals. They do not
                receive your documents, transcripts, connected-app credentials
                or advice history.
              </p>
            </>
          )}
        </>
      ) : null}
      {confirmation && (
        <ConfirmDialog
          title={confirmation.title}
          confirm={confirmation.confirm}
          busy={busy}
          onCancel={() => {
            setConfirmation(null);
            setError("");
          }}
          onConfirm={() =>
            void run(async () => {
              await confirmation.action();
              setConfirmation(null);
            })
          }
        >
          <p>{confirmation.description}</p>
          {error && <Alert>{error}</Alert>}
        </ConfirmDialog>
      )}
    </main>
  );
}
