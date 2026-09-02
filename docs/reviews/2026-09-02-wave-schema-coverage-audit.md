# Wave schema coverage audit, 2026-09-02

Method: an unauthenticated introspection query against
`https://gql.waveapps.com/graphql/public` (the same endpoint
`scripts/smoke-validate-graphql.mjs` uses) dumped every root field, `Business`
field, mutation, input type, and enum. A script then matched each schema field,
argument, input field, and enum value against the identifiers in `index.js`.
Token matching over-counts coverage slightly, so the gaps below were checked by
hand. Wave publishes no separate API changelog; the API Reference page
(published 2026-07-29) agrees with the live schema.

## Operations: complete

- Every `Query` root field (11) has a tool.
- Every `Business` sub-query (18) has a tool, including `emailSendEnabled`
  and `invoiceEstimateSettings`.
- Every mutation (44) has a tool. Wave still exposes no query for money
  transactions and no vendor mutations, so those gaps are Wave's, not ours.

## Live regression handled today

`AccountSubtype.archivable` is declared `Boolean!` in both the live schema and
the docs, yet Wave returned null for it on the accounts query, which nulled the
whole response. Fixed in 1.0.7 by dropping the field from `AccountFields`.
`accountSubtypes` itself still returned it for all 13 ASSET subtypes today.

## Deprecations the server touches

- `moneyDepositTransactionCreate` is marked "Not available for public use at
  this time". `wave_create_deposit_transaction` already documents this and
  points at `wave_create_money_transaction`. Keep, but expect it to break.
- No selected field is deprecated. `internalId`, `Money.raw`, `Province.slug`,
  `InvoiceItem.price`, `InvoiceItemTax.rate`, and the `isClassic*` business
  flags are all avoided.

## Field-level gaps (small, all optional)

| Where | Missing | Worth adding? |
| --- | --- | --- |
| `Business.invoices` args | `sourceId` filter | Low. Filters invoices created from a given estimate. |
| `EstimateCreateInput`, `EstimatePatchInput` | `attachmentIds`, `dontCarryOverNotesToInvoice` | Low. Attachments need an upload path Wave does not expose publicly. The notes flag is a one-liner. |
| `AREstimate` | `dontCarryOverNotesToInvoice` | Pairs with the above. |
| `Invoice` | `anonymousId` | Low. Public-link identifier; could be shown next to `viewUrl`. |
| `InvoicePayment` | `originInvoicePayment` | Low. Links a payment moved between invoices. |
| `OAuthApplication` | `extraData` | No. |

## Tool-schema observations

- Sort parameters are free strings with the enum values named in the
  description, not zod enums. `EstimateSort` is a single value while the other
  three are arrays; the tools already mirror that.
- Currency and country enums are passed through as strings, which is right;
  Wave validates them.

## Verdict

Coverage is complete at the operation level. The only recommended follow-ups
are the `dontCarryOverNotesToInvoice` flag on the two estimate inputs and the
`sourceId` invoice filter, both small.
