// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App, { ApproveStep } from "../../web/src/App";
import { api, type Approval, type Bill, type Config } from "../../web/src/api";
import { friendlyError } from "../../web/src/errors";
import { useRun } from "../../web/src/useRun";

vi.mock("../../web/src/api", async (orig) => {
  const real = await orig<typeof import("../../web/src/api")>();
  return { ...real, api: { config: vi.fn(), approvals: vi.fn(), requests: vi.fn(), propose: vi.fn(), approve: vi.fn(), reject: vi.fn(), trace: vi.fn(), advance: vi.fn(), markPaid: vi.fn(), reset: vi.fn(), fromFixture: vi.fn() } };
});
const mocked = api as unknown as Record<keyof typeof api, ReturnType<typeof vi.fn>>;

const config: Config = { gateway: "mock", agent: "rules", vision: false, fixtures: [], reminderAfterDays: 3, now: "2026-11-12T00:00:00Z" };
const bill = { id: "bill-1", merchant: "Test", receipt: { currency: "EUR", items: [], taxCents: 0, tipCents: 0, totalCents: 0 }, mismatchCents: 0, people: [], assignment: {} } as unknown as Bill;
const pendingApproval: Approval = { id: "apr_1", status: "pending", createdAt: "", action: { kind: "create_request", billId: "bill-1", debtor: "Ben", creditor: "Ana", amountCents: 1000, reason: "owes" } } as Approval;

function Harness() {
  const { busy, run } = useRun();
  return <ApproveStep bill={bill} config={config} busy={busy} run={run} />;
}

beforeEach(() => {
  Object.values(mocked).forEach((m) => m.mockReset());
  mocked.requests.mockResolvedValue([]);
  mocked.trace.mockResolvedValue([]);
});
afterEach(cleanup);

describe("approval queue", () => {
  it("shows an empty state when nothing is waiting", async () => {
    mocked.approvals.mockResolvedValue([]);
    render(<Harness />);
    expect(await screen.findByText(/Nothing waiting for approval/)).toBeTruthy();
  });

  it("a double click on Approve sends one request and disables the buttons while it runs", async () => {
    mocked.approvals.mockResolvedValue([pendingApproval]);
    let release!: () => void;
    mocked.approve.mockImplementation(() => new Promise<void>((r) => (release = r)));
    render(<Harness />);
    const btn = await screen.findByRole("button", { name: /Approve & send/ });
    const user = userEvent.setup();
    await user.dblClick(btn);
    expect(mocked.approve).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: /Sending/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(mocked.approvals).toHaveBeenCalledTimes(2));
  });

  it("a double click on 'Ask the agent' sends one propose call", async () => {
    mocked.approvals.mockResolvedValue([]);
    let release!: () => void;
    mocked.propose.mockImplementation(() => new Promise<void>((r) => (release = r)));
    render(<Harness />);
    const user = userEvent.setup();
    await user.dblClick(await screen.findByRole("button", { name: /Ask the agent to check/ }));
    expect(mocked.propose).toHaveBeenCalledTimes(1);
    release();
  });
});

describe("App", () => {
  it("shows an actionable message for a PayPal auth error", async () => {
    mocked.config.mockResolvedValue({ ...config, fixtures: ["restaurant-4"] });
    mocked.fromFixture.mockRejectedValue(new Error("Request failed with status 401 Unauthorized"));
    render(<App />);
    await userEvent.setup().click(await screen.findByRole("button", { name: /Trattoria/ }));
    expect(await screen.findByText(/PAYPAL_CLIENT_ID/)).toBeTruthy();
  });
});

describe("friendlyError", () => {
  it("names PayPal credentials on an auth error", () => {
    expect(friendlyError("PayPal 401 Unauthorized")).toMatch(/PAYPAL_CLIENT_ID.*PAYPAL_CLIENT_SECRET/);
  });
  it("names the cent difference on a receipt mismatch", () => {
    expect(friendlyError("Fix the receipt first: it is off by 1 cents")).toMatch(/1 cent more/);
    expect(friendlyError("Fix the receipt first: it is off by -25 cents")).toMatch(/25 cents more/);
  });
  it("passes other errors through", () => {
    expect(friendlyError("Unknown bill bill-9")).toBe("Unknown bill bill-9");
  });
});
