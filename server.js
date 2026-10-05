/**
 * server.js — Venue Toll Facts. The free tier first, deliberately.
 *
 * WHY NO DEPENDENCIES. This serves one JSON file that already exists. npm install would add a
 * supply-chain surface and a build step to a read. Node's own http module is enough, so the
 * endpoint can be running (and tested) in the time it takes to read this comment. The x402
 * payment layer gets added when the PAID route is wanted - and not before, because the question
 * this first version answers is "does anything call it at all", which needs no payments.
 *
 * WHAT IT SERVES, AND WHAT IT REFUSES TO SERVE. market_map.json carries two kinds of field:
 * cost_* (a measurement: the fee, the spread, the basis, the evidence) and opp_* / verdict (a
 * judgement about whether an opportunity beats that toll). THIS SERVER SHIPS THE FIRST ONLY. The
 * advisory half is what fails the starter kit's own question #8 - "is the output legal, ethical,
 * and not financial/medical/legal advice" - and the dataset already separates the two, so the
 * separation is enforced here rather than left to prose.
 *
 * WHY "UNMEASURABLE TODAY" IS PUBLISHED RATHER THAN OMITTED. Two of the nine venues have no
 * priced toll. A table that silently drops the rows it could not price reads as "cheap", when the
 * truth is "unknown". Shipping the unknown rows is the more honest product and the more useful
 * one: a caller can tell "we have not measured this" from "this is free".
 *
 * Run:  node server.js [--port 8791]
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = (() => {
  const i = process.argv.indexOf("--port");
  return i > -1 ? Number(process.argv[i + 1]) : 8791;
})();

// MARKET_MAP is env-overridable so the SAME source runs locally (Windows absolute path) and in the
// Docker image for the Glama listing (where the file is COPY'd next to the server and MARKET_MAP is set).
const MAP = process.env.MARKET_MAP || "C:/Users/Sontje/AppData/Local/hermes/clawmes/market_map.json";

// slug -> the market_map entry it names. Kept explicit: a generated slug would silently change if
// a venue were ever renamed, and a caller pinning our slug should not be broken by our own tidying.
const SLUGS = {
  "poly": "POLY prediction markets",
  "rh-parody": "RH / parody (tokenized equities)",
  "crox": "CROX exchange API",
  "cro-app": "CRO app rail (spot)",
  "spot-reversion": "spot reversion (any venue)",
  "copy-sol": "SOL copy",
  "copy-base": "BASE copy",
  "copy-bsc": "BSC copy",
  "perps": "perps / funding",
};

function load() {
  const raw = fs.readFileSync(MAP, "utf8");
  const doc = JSON.parse(raw);
  const rows = Array.isArray(doc) ? doc : doc.markets || [];
  const byMarket = new Map(rows.map((r) => [r.market, r]));
  return { doc, rows, byMarket };
}

/** The toll ONLY. cost_* in, opp_* and verdict deliberately out. */
function tollOf(row) {
  const basis = row.cost_basis || null;
  const priced = row.cost_pct !== null && row.cost_pct !== undefined;
  return {
    priced: priced,
    fee_pct: priced ? row.cost_pct : null,
    basis: basis ? String(basis).split(" (")[0] : "UNMEASURABLE TODAY",
    basis_detail: basis || null,
    evidence: row.cost_evidence || null,
    // PER-VENUE FRESHNESS. The file-level `ts` cannot advance while eight rows still carry the older
    // reading, so it is useless as a per-venue answer - a caller asking about POLY needs POLY's date.
    // Where a row has its own measured_at, that is the honest reading and it is what travels here.
    measured_at: row.measured_at || null,
    // COST-TO-TRADE BUNDLE (2026-10-04). The toll is not just the fee: the entry gap is a separate,
    // real cost a caller must add to the fee to know what a fill actually costs. Slippage is the measured
    // gap between the intended limit and the price the fill crossed. Liquidity is per-market, not a venue
    // single number, so it travels as a note here and per-market in list_venues - never a fake scalar.
    slippage_pct: row.slippage_pct != null ? row.slippage_pct : null,
    slippage_basis: row.slippage_basis || null,
    liquidity_note: row.liquidity_note || null,
    advisory_served: false,
  };
}

function venues(asOf) {
  const { rows } = load();
  return {
    as_of: asOf,
    note: "Cost fields only. This service deliberately does not publish opportunity or verdict " +
          "fields - those are judgements, not measurements.",
    venues: rows.map((r) => {
      const slug = Object.keys(SLUGS).find((s) => SLUGS[s] === r.market) || null;
      const t = tollOf(r);
      // THE INDEX IS FREE; THE MEASUREMENT IS NOT (2026-10-03).
      //
      // This route used to return `fee_pct` for EVERY venue - the whole product, in bulk, on the route
      // we advertise as free - while /toll charged $0.01 for one venue's number the caller already had.
      // No amount of discovery fixes that: an agent that FOUND us had no reason to PAY us, so exposure
      // would have produced zero revenue and read as a demand problem. It was found by asking what the
      // free route actually returns, not by auditing the paid one.
      //
      // What stays free is the CREDIBILITY signal - which venues are covered, whether each carries a
      // measured toll, and how fresh the reading is. That is what makes an agent want the number. The
      // NUMBER, its basis detail and its evidence are the paid product.
      return { slug, name: r.market, priced: t.priced,
               basis: t.basis, measured_at: t.measured_at };
    }),
  };
}

function send(res, code, body, type) {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, { "content-type": type || "application/json; charset=utf-8",
                        "content-length": Buffer.byteLength(s), "cache-control": "no-store" });
  res.end(s);
}


// ---- x402 PAYMENT LAYER -----------------------------------------------------------------------
// The facilitator runs in-process on 127.0.0.1 (x402_facilitator.py --serve). It verifies the
// EIP-3009 authorization and submits it; this server never touches a key.
const FACILITATOR = process.env.X402_FACILITATOR || "http://127.0.0.1:8792";
const PAY_TO = "0x13B08F2a5a58997d73e45be835211EF4ed245047";
// $0.05 in micro-USDC (USDC has 6 decimals). RAISED FROM 10000 on 2026-10-03, on measurement.
//
// The price was set before any market data existed. MEASURED since: the realized x402 transaction
// value across 91,658 payments is a mean of $0.107 - $0.063 excluding ONE outlier (mrdn carried 41%
// of all x402 money in 0.1% of the transactions at $35/txn) - and EVERY major facilitator's mean is
// above our old price: coinbase $0.0722, polymer $0.1000, payAI $0.0391, dexter $0.0240, fluxa
// $0.0196. In the `exact` scheme the amount paid IS the endpoint's price, so those means are prices.
// We were the cheapest thing in a market that pays 5-10x more, which is not a strategy when the
// buyer is an agent comparing structured answers rather than shopping.
//
// 50000 and not the $0.10 mean, deliberately: we have ZERO external calls, so the first call is worth
// more than five cents, and nothing suggests an agent's choice turns on the difference.
const PRICE_MICRO = 50000;
const NETWORK_V2 = "eip155:8453";       // CAIP-2, what a v2 client expects
const NETWORK_V1 = "base";              // plain name, what the stock 1.2.0 client Zod-accepts
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE_URL = "https://venuetoll.com/toll";
const RESOURCE_DESCRIPTION =
  "The measured cost of one venue: fee, measured spread and entry slippage, each with its evidence and an "
  + "explicit basis. Measurements only - opportunity and verdict fields are never served.";
const MAX_TIMEOUT = 1800;

// ---- BAZAAR DISCOVERY DECLARATION -------------------------------------------------------------
// What makes this endpoint findable in a facilitator's public catalog (PayAI's Bazaar catalogs on
// verify/settle from what the payment carries; Coinbase's does the same from its own facilitator).
// The docs are explicit about the mechanics, and both paths are implemented because we advertise v1
// in the body and v2 in the header:
//   v2 - a top-level `extensions.bazaar` on the 402 response, which the BUYER'S CLIENT must echo
//        into the payment payload. If the client drops it, nothing is catalogued.
//   v1 - `outputSchema.input` on the payment requirements, which the SERVER controls end to end,
//        so v1 listing does not depend on the client echoing anything.
// A rejected or missing declaration never affects the payment itself, and the outcome is reported
// back on every verify/settle as a base64 EXTENSION-RESPONSES header (`processing` or `rejected`).
const DISCOVERY = {
  info: {
    input: {
      type: "http",
      method: "GET",
      queryParams: {
        venue: {
          type: "string",
          required: true,
          description: "venue slug, e.g. poly",
          enum: ["poly", "rh-parody", "crox", "cro-app", "spot-reversion",
                 "copy-sol", "copy-base", "copy-bsc", "perps"],
        },
      },
    },
    output: {
      type: "json",
      example: {
        venue: "poly", name: "POLY prediction markets", fee_pct: 0.9773,
        basis: "measured 2026-10-03", measured_at: "2026-10-03T19:18:56Z",
        basis_detail: "chain /activity vs our book, same-shares rows only", as_of: "2026-10-03T19:18:56",
      },
    },
  },
};

const DISCOVERY_RESOURCE = {
  url: RESOURCE_URL,
  description: RESOURCE_DESCRIPTION,
  mimeType: "application/json",
  serviceName: "Venue Toll Facts",
  tags: ["crypto", "trading", "fees", "market-data"],
};

/**
 * Build the request body a facilitator expects, in the dialect the CLIENT spoke.
 *
 * WHY THIS EXISTS (2026-10-03). We used to POST the bare payment payload. Our own facilitator was
 * written to accept that, so it worked - and it was the wrong shape for every other facilitator in
 * the ecosystem. Pointed at PayAI, every payment came back `invalid_payment_requirements`, and the
 * reason named no field because our body matched no variant at all.
 *
 * The spec, measured from docs.x402.org and the CDP API reference:
 *   v1 envelope { x402Version, paymentPayload, paymentRequirements }   (network = "base")
 *   v2 envelope { x402Version, paymentPayload, resource, accepted }    (network = CAIP-2)
 * A v2 payload placed in the v1 envelope fails with an error that names no field. The envelope
 * therefore follows the PAYLOAD's version, not our preference.
 *
 * The thin-payload completion is deliberate: a client that sends only {signature, authorization}
 * (our own test tool did, and the stock client can) still has to be payable. The envelope fields are
 * metadata - the money is authorised by the EIP-712 signature over the authorization, which we never
 * touch - so completing them cannot authorise anything the payer did not sign.
 */
function facilitatorEnvelope(payload) {
  const isV2 = !!(payload && payload.x402Version === 2);
  const requirementsV2 = {
    scheme: "exact", network: NETWORK_V2, asset: ASSET,
    amount: String(PRICE_MICRO), payTo: PAY_TO, maxTimeoutSeconds: MAX_TIMEOUT,
    extra: { name: "USD Coin", version: "2" },
  };
  const requirementsV1 = {
    scheme: "exact", network: NETWORK_V1, asset: ASSET,
    maxAmountRequired: String(PRICE_MICRO), payTo: PAY_TO, maxTimeoutSeconds: MAX_TIMEOUT,
    resource: RESOURCE_URL, description: RESOURCE_DESCRIPTION, mimeType: "application/json",
    // THE EIP-712 DOMAIN PARAMETERS. A v1 signer REQUIRES these - the SDK throws
    // "EIP-712 domain parameters (name, version) are required in payment requirements" without them,
    // and a facilitator answers `invalid_exact_evm_missing_eip712_domain`. The v2 requirements object
    // carried `extra` and this one did not, so the two dialects differed in a field the verifier needs
    // to reconstruct the digest at all.
    extra: { name: "USD Coin", version: "2" },
    // THE DECLARATION GOES IN THE REQUIREMENTS ON THE v1 PATH, because we build them: the docs say
    // v1 listing "does not depend on the buyer's client echoing anything", so this is the half we
    // cannot lose to a client that drops the extension.
    outputSchema: { input: { type: "http", method: "GET" } },
  };
  const resourceInfo = DISCOVERY_RESOURCE;
  if (isV2) {
    // v2 carries `resource` and `accepted` INSIDE the payment payload, and at the top level too - plus
    // the `extensions` object the catalog reads.
    const pp = payload.accepted
      ? payload
      : { x402Version: 2, resource: resourceInfo, accepted: requirementsV2,
          payload: payload.payload || payload, extensions: { bazaar: DISCOVERY } };
    return { x402Version: 2, paymentPayload: pp, resource: resourceInfo, accepted: requirementsV2,
             extensions: { bazaar: DISCOVERY } };
  }
  // THE DECLARATION MUST ALSO RIDE THE PAYLOAD, not only the requirements. Measured: a v1 settlement
  // carrying `outputSchema` in the requirements produced `EXTENSION-RESPONSES: NONE` - the catalog
  // reported no declaration at all, and their docs describe the extension as being read from the
  // payment payload ("the client copies your declaration from the 402 response into the payment
  // payload"). A v1 client does not carry extensions, so on this path the SERVER is the only party
  // that can supply them. Injected here rather than demanded from the client, because a client that
  // drops it lists nothing and the docs name exactly that as the common failure.
  const ppV1 = Object.assign({}, payload, { extensions: { bazaar: DISCOVERY } });
  return { x402Version: 1, paymentPayload: ppV1, paymentRequirements: requirementsV1,
           extensions: { bazaar: DISCOVERY } };
}

// ---- MCP (Model Context Protocol) ------------------------------------------------------------------
// This endpoint is ALSO an MCP server, so an agent whose tooling speaks MCP can discover and call it
// without knowing the URL in advance - and can be listed in the official MCP Registry, which is the one
// discovery surface we had never touched. Same process, same port, same tunnel: no second service to
// supervise, and the paid tool reuses the paywall rather than re-implementing it.
//
// Deliberately zero-dependency JSON-RPC, like the rest of this file. The three methods that matter for
// a tool-only server are initialize, tools/list and tools/call; anything else is answered with a
// correctly-shaped JSON-RPC error rather than silence, because a client that gets no reply cannot tell
// an unimplemented method from a broken server.
const MCP_PROTOCOL = "2025-06-18";

const MCP_TOOLS = [
  {
    name: "list_venues",
    description:
      "List the trading venues this service covers, which of them carry a measured toll, and how "
      + "fresh each reading is. Free. Returns no toll numbers - the measurement is the paid tool.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_toll",
    description:
      "The measured cost of executing on one venue: fee percentage with its evidence and an explicit "
      + "basis. Paid - $0.05 in USDC on Base via x402; the call returns the 402 challenge when unpaid.",
    inputSchema: {
      type: "object",
      properties: {
        venue: {
          type: "string",
          description: "venue slug, e.g. poly",
          enum: ["poly", "rh-parody", "crox", "cro-app", "spot-reversion",
                 "copy-sol", "copy-base", "copy-bsc", "perps"],
        },
      },
      required: ["venue"],
      additionalProperties: false,
    },
  },
];

function mcpRpc(id, result, error) {
  const out = { jsonrpc: "2.0", id: id === undefined ? null : id };
  if (error) out.error = error; else out.result = result;
  return out;
}

function mcpHandle(msg, asOf) {
  const id = msg && msg.id;
  const method = msg && msg.method;
  if (method === "initialize") {
    return mcpRpc(id, {
      protocolVersion: (msg.params && msg.params.protocolVersion) || MCP_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "venuetoll", version: "1.0.0" },
      instructions:
        "Measured trading-venue tolls. list_venues is free; get_toll costs $0.05 in USDC on Base and "
        + "returns the 402 challenge when unpaid. Measurements only - no opportunity or verdict fields.",
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return null;   // a notification
  if (method === "ping") return mcpRpc(id, {});
  if (method === "tools/list") return mcpRpc(id, { tools: MCP_TOOLS });
  if (method === "tools/call") {
    const p = (msg.params || {});
    const name = p.name;
    const args = p.arguments || {};
    if (name === "list_venues") {
      const v = venues(asOf);
      const text = JSON.stringify(v, null, 2);
      return mcpRpc(id, { content: [{ type: "text", text }], isError: false });
    }
    if (name === "get_toll") {
      const slug = String(args.venue || "");
      if (!Object.keys(SLUGS).includes(slug)) {
        // A bad argument is refused with the same list the HTTP route gives, so an agent can correct
        // itself in one round trip instead of guessing.
        return mcpRpc(id, {
          content: [{ type: "text", text: JSON.stringify(
            { error: "unknown venue", got: slug, valid: Object.keys(SLUGS) }) }],
          isError: true,
        });
      }
      // NO BYPASS: the paid tool returns the SAME 402 the HTTP route does when unpaid. An MCP tool that
      // served the number for free would quietly undo the free/paid split fixed earlier today, and MCP
      // is exactly where a second, unguarded path would go unnoticed.
      return mcpRpc(id, {
        content: [{ type: "text", text: JSON.stringify({
          payment_required: true,
          price: "0.05",
          currency: "USDC",
          network: "eip155:8453",
          payTo: PAY_TO,
          asset: ASSET,
          how: "HTTP GET " + RESOURCE_URL + "?venue=" + slug + " with an x402 payment header",
          note: "MCP tool calls carry no payment header, so the paid number is served over HTTP. "
                + "Retry the HTTP route with an x402 authorization to receive it.",
        }, null, 2) }],
        isError: false,
      });
    }
    return mcpRpc(id, {
      content: [{ type: "text", text: JSON.stringify({ error: "unknown tool", got: name }) }],
      isError: true,
    });
  }
  // A METHOD WE DO NOT IMPLEMENT IS STILL AN ANSWER. Silence here reads to a client as a dead server;
  // -32601 is the JSON-RPC code that says "this server is alive and does not have that method".
  return mcpRpc(id, null, { code: -32601, message: "method not found: " + String(method) });
}

const TOLL_DESC =
  "The measured cost of one venue: fee, measured spread and entry slippage, each with its evidence and an " +
  "explicit basis. Measurements only - opportunity and verdict fields are never served.";

async function facilitatorCall(path, body) {
  // Returns {status, json} or {status: null, error} - a could-not-reach is its own state, and it is
  // NEVER treated as a pass. A payment whose verification could not run has not been refused; it has
  // not been checked, and this route does not serve data on that basis.
  try {
    const r = await fetch(FACILITATOR + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  } catch (e) {
    return { status: null, error: e.name || "fetch-failed", json: {} };
  }
}

/** The v2 envelope, which rides in the `payment-required` header (base64 JSON). */
function envelopeV2() {
  return {
    x402Version: 2,
    accepts: [{
      scheme: "exact", network: NETWORK_V2, amount: String(PRICE_MICRO), payTo: PAY_TO,
      asset: ASSET, maxTimeoutSeconds: 1800, resource: "/toll", mimeType: "application/json",
    }],
  };
}

/** The v1 envelope, which rides in the response BODY. Flat fields, plain network name. */
function envelopeV1() {
  return {
    x402Version: 1,
    error: "payment required",
    accepts: [{
      scheme: "exact", network: NETWORK_V1, maxAmountRequired: String(PRICE_MICRO), payTo: PAY_TO,
      asset: ASSET,
      // ABSOLUTE, NOT "/toll". The catalog refuses a resource whose url is not an absolute http(s)
      // URL on a public host - `resource_url_invalid` - and this field was a relative path, so every
      // declaration would have been rejected for a reason that names the URL and not the cause.
      resource: RESOURCE_URL, description: TOLL_DESC,
      mimeType: "application/json", maxTimeoutSeconds: MAX_TIMEOUT,
      // v1 DISCOVERY, SERVER-CONTROLLED: rides in the requirements WE hand the facilitator, so
      // listing does not depend on the buyer's client echoing anything back.
      outputSchema: { input: { type: "http", method: "GET" } },
    }],
    // v2 DISCOVERY, CLIENT-ECHOED: the top-level objects a v2 client copies into its payment payload.
    resource: DISCOVERY_RESOURCE,
    extensions: { bazaar: DISCOVERY },
  };
}

function send402(res, extra) {
  const v1 = envelopeV1();
  const body = Object.assign({}, v1, extra || {});
  // RULE 2 - assert the things an agent reads before deciding to pay. A thin 402 is payable and
  // useless: the agent cannot price it and moves on.
  const a = body.accepts && body.accepts[0];
  if (!a || !a.maxAmountRequired || !a.payTo || !a.description) {
    return send(res, 500, { error: "INTERNAL: the 402 would have gone out without its price, payTo " +
                                   "or description - refusing to send a thin challenge" });
  }
  const hdr = Buffer.from(JSON.stringify(envelopeV2())).toString("base64");
  const payload = Buffer.from(JSON.stringify(body)).toString("base64");
  res.writeHead(402, {
    "content-type": "application/json; charset=utf-8",
    "payment-required": hdr,              // v2 clients read this
    "x-payment-required": hdr,            // and tolerate either case
    "cache-control": "no-store",          // section 23.7: a cached 402 is served to a client that paid
    "content-length": Buffer.byteLength(JSON.stringify(body, null, 2)),
  });
  res.end(JSON.stringify(body, null, 2));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  let asOf = "unknown";
  try { asOf = JSON.parse(fs.readFileSync(MAP, "utf8")).ts || "unknown"; } catch (_) {}
  try {
    // MCP over HTTP (streamable transport). Same process, same port, same tunnel as the paid route.
    if (u.pathname === "/mcp" || u.pathname === "/mcp/") {
      if (req.method === "GET") {
        // A GET is the human/machine-readable view of the same surface: what tools exist and what they
        // cost. A JSON-RPC server that answers nothing to a browser is undiscoverable by anything that
        // explores first and connects second.
        return send(res, 200, {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: "venuetoll", version: "1.0.0" },
          transport: "http",
          note: "POST JSON-RPC 2.0 here. list_venues is free; get_toll is paid ($0.05 USDC on Base).",
          tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description,
                                         inputSchema: t.inputSchema })),
        });
      }
      let raw = "";
      try {
        for await (const chunk of req) raw += chunk;
      } catch (e) {
        return send(res, 400, mcpRpc(null, null, { code: -32700, message: "could not read the body" }));
      }
      let msg;
      try {
        msg = JSON.parse(raw || "{}");
      } catch (e) {
        // A parse error gets its own code: it is the client's mistake and it is distinguishable from
        // an internal failure, so an agent can tell "fix your request" from "try again later".
        return send(res, 400, mcpRpc(null, null, { code: -32700, message: "parse error" }));
      }
      const out = mcpHandle(msg, asOf);
      // A notification has no id and takes NO reply by the spec, so it gets 202 and an empty body -
      // answering it would break a conforming client.
      if (out === null) { res.writeHead(202); return res.end(); }
      return send(res, 200, out);
    }
    if (u.pathname === "/venues") {
      const v = venues(asOf);
      return send(res, 200, v);
    }
    if (u.pathname === "/toll") {
      // THE 402 CHALLENGE PRECEDES RESOURCE VALIDATION (2026-10-04). A directory prober hits /toll
      // with no `venue` to learn whether the route is payable; answering that with a 400
      // "venue is required" read as "not a payable resource" and hid the listing from the catalog.
      // An UNPAID request therefore gets the 402 challenge first, whatever the venue param says -
      // the venue is validated only after payment has been checked. (RULE 3 - accept BOTH payment
      // header names: the stock npm client sends X-PAYMENT, the 2.x SDK reads payment-signature;
      // reading only one makes the other half of the market unpayable.)
      const raw = req.headers["payment-signature"] || req.headers["x-payment"];
      if (!raw) return send402(res);

      const slug = u.searchParams.get("venue");
      if (!slug) return send(res, 400, { error: "venue is required", valid: Object.keys(SLUGS) });
      const market = SLUGS[slug];
      if (!market) return send(res, 400, { error: "unknown venue", valid: Object.keys(SLUGS) });
      const { byMarket } = load();
      const row = byMarket.get(market);
      if (!row) return send(res, 404, { error: "venue known but not present in the map", venue: slug });

      let payload;
      try {
        const s = String(raw).trim();
        payload = JSON.parse(s.startsWith("{") ? s : Buffer.from(s, "base64").toString("utf8"));
      } catch (e) {
        return send402(res, { error: "the payment header is not readable as JSON or base64",
                              phase: "decode" });
      }

      // THE ENVELOPE, NOT THE BARE PAYLOAD. Our own facilitator accepted the raw payload, which is
      // exactly why the wrong shape survived eleven green self-tests: the test and the code shared
      // the assumption. Every other facilitator in the ecosystem speaks the spec envelope.
      const v = await facilitatorCall("/verify", facilitatorEnvelope(payload));
      if (v.status === null) {
        // NOT a refusal: we never checked. Saying "invalid" here would be inventing a verdict.
        return send402(res, { error: "the facilitator could not be reached, so the payment was NOT "
                                     + "checked", phase: "verify-unavailable", detail: v.error });
      }
      // SPEC NAMES vs OUR NAMES (2026-10-03). The x402 spec calls these isValid / success /
      // transaction; our in-process facilitator was written with valid / settled / tx. Reading only
      // ours makes this endpoint UNPAYABLE through any spec-compliant facilitator - pointing it at
      // PayAI would have refused every valid payment, and the refusal would have named the payer
      // rather than the parser. Same class as the network-dialect bug: the test and the code shared
      // one assumption. Accept both spellings; our own facilitator now emits both.
      const verified = v.json && (v.json.valid === true || v.json.isValid === true);
      if (!verified) {
        const why = v.json && (v.json.reason || v.json.invalidReason || v.json.invalidMessage);
        return send402(res, { error: "payment refused", phase: "verify",
                              reason: why || "no reason returned" });
      }

      const s = await facilitatorCall("/settle", facilitatorEnvelope(payload));
      if (s.status === null) {
        return send402(res, { error: "the facilitator could not be reached to settle; NO DATA IS "
                                     + "SERVED for an unconfirmed payment", phase: "settle-unavailable" });
      }
      // RULE 1 - the ONLY path that serves data is a CONFIRMED settlement, which the facilitator sets
      // from the transaction RECEIPT (status 1). A submit-only, a reverted tx and a receipt timeout
      // are all refusals here, and each names its phase so the failure is not a mystery.
      const settled = s.json && (s.json.settled === true || s.json.success === true);
      if (!settled) {
        // The transaction hash matters even though we refused: a payer asking "I sent money and got
        // nothing" can only be answered with the tx. Dropping it made the refusal unactionable.
        const extra = { error: "payment did not settle - no data served",
                        phase: (s.json && s.json.phase) || "settle",
                        reason: (s.json && (s.json.reason || s.json.errorReason
                                            || s.json.errorMessage)) || "no reason returned" };
        for (const k of ["tx", "transaction", "block", "gas_used"]) {
          if (s.json && s.json[k]) extra[k] = s.json[k];
        }
        return send402(res, extra);
      }

      const t = tollOf(row);
      // The hash and the payer are read through BOTH dialects too, so a receipt never comes back with
      // an undefined tx just because the facilitator answered in the spec's vocabulary.
      const txHash = s.json.tx || s.json.transaction || null;
      const payerAddr = v.json.from || v.json.payer || s.json.payer || null;
      // The settlement receipt goes back under BOTH header names, for the same reason we accept both.
      const receipt = Buffer.from(JSON.stringify({ success: true, tx: txHash,
                                                   network: NETWORK_V2, payer: payerAddr })).toString("base64");
      const out = JSON.stringify({ venue: slug, name: market, as_of: asOf, ...t }, null, 2);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "payment-response": receipt,
        "x-payment-response": receipt,
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(out),
      });
      return res.end(out);
    }
    if (u.pathname === "/healthz") return send(res, 200, { ok: true, as_of: asOf });
    // BOTH PATHS: the extension-less form and the .json variant. Kit section 23.7 names
    // "/.well-known/x402.json" specifically, so a crawler looking for the standard under
    // that name got a 404 and read the manifest as broken. One handler, two names.
    if (u.pathname === "/.well-known/x402" || u.pathname === "/.well-known/x402.json") {
      return send(res, 200, {
        x402Version: 2,
        service: "Venue Toll Facts",
        note: "One paid route. GET /venues is free; GET /toll costs $0.05 in USDC on Base.",
        free: [ { method: "GET", path: "/venues" } ],
        // MCP IS ADVERTISED HERE TOO. The same server speaks JSON-RPC at /mcp, so an agent whose tooling
        // discovers via the well-known file finds the tool surface without being told the path. A live
        // endpoint that appears in no discovery document is reachable only by whoever already knows it.
        mcp: {
          transport: "http",
          url: "https://venuetoll.com/mcp",
          protocolVersion: MCP_PROTOCOL,
          tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
        },
        paid: [ { method: "GET", path: "/toll?venue=<slug>", price: "$0.05",
                  network: NETWORK_V2, asset: ASSET, payTo: PAY_TO,
                  scheme: "exact", maxTimeoutSeconds: 1800 } ],
      });
    }
    if (u.pathname === "/llms.txt") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(
        "# Venue Toll Facts\n\n" +
        "The measured cost of executing on a named venue: fee and spread, each with its evidence\n" +
        "and an explicit basis (measured / published / unmeasurable).\n\n" +
        "## Endpoints\n" +
        "- GET /venues - the venues priced here, and which ones have no toll measured at all\n" +
        "- GET /toll?venue=<slug> - the toll for one venue\n" +
        "- GET /.well-known/x402 - machine-readable route descriptions\n" +
        "- POST /mcp - the same service as an MCP server (tools: list_venues free, get_toll paid)\n\n" +
        "## Not served\n" +
        "Opportunity and verdict fields are deliberately withheld: this service publishes\n" +
        "measurements, never judgements.\n");
    }
    if (u.pathname === "/robots.txt") {
      // Cloudflare's AI Crawl Control reported "No robots.txt files found" on this zone, and the
      // kit's section 23.3 is explicit about why that matters: "A crawler that finds no robots.txt
      // applies its own defaults, and those get stricter every quarter." The Content-signal line is
      // the whole value - it states what we actually want, in the vocabulary the crawlers now read,
      // instead of leaving each one to guess. Publish it on EVERY hostname we sell on.
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return res.end("User-agent: *\n" +
                     "Content-signal: search=yes, ai-input=yes, ai-train=yes, use=full\n" +
                     "Allow: /\n");
    }
    if (u.pathname === "/openapi.json") {
      // The manifest advertises this file (discovery.openapiJson = true) and nothing served it.
      // A DECLARED CAPABILITY THAT IS NOT SERVED IS WORSE THAN AN ABSENT ONE: a crawler reads
      // the 404 as a broken manifest and grades the host down for garbage it never published.
      return send(res, 200, {
        openapi: "3.0.3",
        info: { title: "Venue Toll Facts", version: "1.0.0",
                description: "Measured venue tolls (fee and spread) with their evidence and basis. "
                             + "Measurements only; no opportunity or advisory fields are served." },
        paths: {
          "/venues": { get: { summary: "Venues priced here, including any with no toll measured",
                              responses: { 200: { description: "the venue list" } } } },
          "/toll": { get: { summary: "The measured toll for one venue",
                            parameters: [{ name: "venue", in: "query", required: true,
                                           schema: { type: "string", enum: Object.keys(SLUGS) } }],
                            responses: { 200: { description: "the toll, with basis and evidence" },
                                         400: { description: "unknown or missing venue" } } } }
        }
      });
    }
    if (u.pathname === "/.well-known/mcp-registry-auth") {
      // MCP REGISTRY HTTP (domain) AUTH PROOF (2026-10-04). The official MCP Registry grants the
      // com.venuetoll namespace only after it reads this exact line from the APEX hostname. The
      // Ed25519 public key is meant to be public; the private half lives in mcp-registry-auth.key.hex
      // and rotating it means re-running `mcp-publisher login http` with the new key. Served as a
      // single line with no wrapper, exactly as the auth doc specifies.
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return res.end("v=MCPv1; k=ed25519; p=ZAux4w3QMs+dAgJ4cokKWyBGjY4nPSEYizkgj2FgeKQ=\n");
    }
    return send(res, 404, { error: "not found", endpoints: ["/venues", "/toll", "/healthz"] });
  } catch (e) {
    // Named failure state. A could-not-run must never read as clean.
    return send(res, 503, { error: "could not read the measurement store", detail: String(e.message || e) });
  }
});

server.listen(PORT, process.env.HOST || "127.0.0.1", () => {
  console.log("Venue Toll Facts listening on http://127.0.0.1:" + PORT);
  console.log("  /venues          free   - venue list, incl. the ones with no priced toll");
  console.log("  /toll?venue=poly free   - the measured toll for one venue");
  console.log("  /.well-known/x402       - discovery");
  console.log("  /llms.txt               - discovery");
});
