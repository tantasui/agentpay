import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaymentRequest } from "../src/payment-request.ts";
import { createRequestStore } from "../src/seller/request-store.ts";

let clock = 1_000_000;
const now = () => clock;

function request(id: string, expiresIn = 60_000): PaymentRequest {
  return {
    version: 1,
    requestId: id,
    amount: "200000000000000",
    assetId: "nep141:base.omft.near",
    chain: "base",
    symbol: "ETH",
    decimals: 18,
    recipient: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
    expiresAt: new Date(clock + expiresIn).toISOString(),
  };
}

test("a paid request id is served once, and the second use is refused", () => {
  const store = createRequestStore({ now });
  store.issue(request("a"));
  const claim = store.claim("a", "dep-1");
  assert.equal(claim.ok, true);
  store.confirm("a");
  const again = store.claim("a", "dep-1");
  assert.equal(again.ok, false);
  assert.match(again.ok ? "" : again.reason, /already served/);
});

test("unknown request ids are refused", () => {
  const store = createRequestStore({ now });
  const claim = store.claim("nope", "dep-1");
  assert.equal(claim.ok, false);
  assert.match(claim.ok ? "" : claim.reason, /unknown/);
});

test("expired ids are refused once the grace period has passed", () => {
  const store = createRequestStore({ now, graceMs: 5_000 });
  store.issue(request("a", 1_000));
  clock += 1_000 + 4_000;
  assert.equal(store.claim("a", "dep-1").ok, true, "inside the grace period");
  store.release("a");
  clock += 2_000;
  const late = store.claim("a", "dep-1");
  assert.equal(late.ok, false);
  assert.match(late.ok ? "" : late.reason, /expired/);
});

test("a deposit address pays for one request only", () => {
  const store = createRequestStore({ now });
  store.issue(request("a"));
  store.issue(request("b"));
  assert.equal(store.claim("a", "dep-1").ok, true);
  store.confirm("a");
  const reuse = store.claim("b", "dep-1");
  assert.equal(reuse.ok, false);
  assert.match(reuse.ok ? "" : reuse.reason, /already used/);
});

test("two checks of the same request cannot run at once", () => {
  const store = createRequestStore({ now });
  store.issue(request("a"));
  assert.equal(store.claim("a", "dep-1").ok, true);
  const second = store.claim("a", "dep-1");
  assert.equal(second.ok, false);
  assert.match(second.ok ? "" : second.reason, /being verified/);
});

test("a deposit address being checked for one request cannot be claimed by another", () => {
  const store = createRequestStore({ now });
  store.issue(request("a"));
  store.issue(request("b"));
  assert.equal(store.claim("a", "dep-1").ok, true);
  assert.equal(store.claim("b", "dep-1").ok, false);
});

test("releasing a failed check lets the request and deposit address be tried again", () => {
  const store = createRequestStore({ now });
  store.issue(request("a"));
  assert.equal(store.claim("a", "dep-1").ok, true);
  store.release("a");
  assert.equal(store.claim("a", "dep-1").ok, true);
});

test("claim returns the issued request", () => {
  const store = createRequestStore({ now });
  const issued = request("a");
  store.issue(issued);
  const claim = store.claim("a", "dep-1");
  assert.deepEqual(claim.ok && claim.request, issued);
});

test("issuing the same id twice is refused", () => {
  const store = createRequestStore({ now });
  store.issue(request("a"));
  assert.throws(() => store.issue(request("a")), /already issued/);
});

test("long-expired requests are dropped, but used deposit addresses are remembered", () => {
  const store = createRequestStore({ now, graceMs: 1_000 });
  store.issue(request("a", 1_000));
  assert.equal(store.claim("a", "dep-1").ok, true);
  store.confirm("a");
  store.issue(request("old", 1_000));
  clock += 10_000;
  store.issue(request("b"));
  assert.equal(store.size(), 1);
  assert.equal(store.claim("b", "dep-1").ok, false);
});
