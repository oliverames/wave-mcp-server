# Evaluation

`evaluation.xml` holds ten read-only questions for measuring how well an LLM
can drive this server. They follow the mcp-builder evaluation format: each is
independent, non-destructive, needs several tool calls, and resolves to one
string-comparable answer.

## The answers are placeholders

**No answer in this file has been verified.** Wave publishes no demo or sandbox
dataset, and the questions were written without access to a Wave account, so
every `<answer>` is a description of the expected shape rather than a real
value. Running the file unchanged will report 0/10.

This is the one part of the mcp-builder process that cannot be completed from
outside a real Wave business. Its Step 4 asks you to explore live content and
derive each answer yourself, which needs a token this repository should not
carry.

## Making it usable

1. Point `WAVE_ACCESS_TOKEN` at a Wave business with real history — ideally one
   with a year or more of invoices, estimates, and payments.
2. Answer each question yourself using only the MCP tools, exactly as the
   evaluated model would.
3. Replace each placeholder `<answer>` with the value you derived.
4. Adjust the date ranges. The questions assume activity in 2025; change them
   to periods your business actually covers.
5. Drop any question your business cannot answer — one with no estimates
   cannot answer the estimate question.

Prefer questions whose answers are **stable**. Question 2 asks for the largest
*overdue* balance, which moves as invoices age and get paid; if you want it to
stay valid, narrow it to a closed period.

## Running

The harness ships with the mcp-builder skill, not this repository:

```bash
export ANTHROPIC_API_KEY=your_key
python scripts/evaluation.py \
  -t stdio \
  -c /absolute/path/to/wave_mcp/.venv/bin/python \
  -a /absolute/path/to/wave_mcp/mcp_server.py \
  -e WAVE_ACCESS_TOKEN=your_token \
  -e WAVE_BUSINESS_ID=your_business_id \
  -o report.md \
  evaluation/evaluation.xml
```

Setting `WAVE_BUSINESS_ID` matters: without it the model has to call
`wave_list_businesses` and `wave_set_default_business` before every question,
which measures setup rather than the tools under test.

## Reading the report

Low accuracy usually points at the tools, not the model. Watch for:

- **Answers that trail off mid-search** — a tool is returning too much. Check
  whether the model used `response_format="markdown"` and a sensible
  `page_size`.
- **The model missing records that exist** — it probably paged once and
  stopped. Tools that need `fetch_all=true` should say so in their
  descriptions.
- **Wrong tool chosen** — two descriptions overlap and need sharpening.
- **The model guessing an ID** — a lookup path is missing.

The agent's per-task feedback in the report is the most useful part; treat it
as a bug list for the tool descriptions.
