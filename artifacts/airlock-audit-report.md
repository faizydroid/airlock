# Pay equity audit

Generated 2026-08-27T20:30:47.077Z

Dataset: 5,000 records. Synthetic, generated in-browser from a fixed seed. No real personal data.

## Disclosure record

| | |
|---|---|
| Individual records released to the agent | **0** |
| Questions asked | 9 |
| Questions refused by policy | 3 |
| Human overrides granted | 0 |
| Human overrides denied | 0 |
| Disclosure budget | 181 of 400 spent |

## Policy in force

- Cohorts below 5 people are not reported on at all.
- Any statistic reading a salary requires at least 20 people.
- Exact headcounts are disclosed only at 50 or above.
- At most 2 dimensions may be combined.
- Permitted statistics: count, mean.
- Excluded: min, max, top-N, stddev, variance, sum, mode, range, median, p25, p75.

## Findings

### Unexplained pay gap concentrated in Engineering and Sales

**critical** — 2026-08-27T20:30:30.206Z

The company-wide raw gap is largely composition: women are under-represented at senior levels. After stratifying by level and function, most functions sit near parity. Engineering and Sales do not, and the gap widens with seniority.

Provenance: `{"stat":"mean","metric":"baseSalary","groupBy":["fn","gender"]}`

## Limitations

- This is not differential privacy. There is no calibrated noise and no epsilon budget. The controls are suppression, clamping, quantization, count banding and a bounded disclosure budget.
- Background knowledge is not defended against. Someone who already knows four salaries in a cohort of five can derive the fifth from its mean. This is irreducible for any system that reports means, and is why the numeric floor is set well above the count floor.
- Marginal reconstruction is mitigated, not eliminated. Given enough overlapping aggregates, integer programming over a quantized value grid narrows individual values.
- The page's own memory is out of scope. Raw records live in this tab; an agent able to execute JavaScript here could read them. The tool interface is a policy boundary, not a sandbox.
- Nothing individual is rendered anywhere, so a screenshot yields only what a tool call would have yielded. That is an architectural choice rather than a claim that the pixel channel does not exist.

## Full disclosure ledger

```json
[
  {
    "seq": 1,
    "at": "2026-08-27T20:30:19.994Z",
    "op": "load_sample",
    "spec": {},
    "outcome": "ok",
    "charged": 0,
    "remaining": 400
  },
  {
    "seq": 2,
    "at": "2026-08-27T20:30:19.994Z",
    "op": "profile",
    "spec": {},
    "outcome": "ok",
    "charged": 0,
    "remaining": 400
  },
  {
    "seq": 3,
    "at": "2026-08-27T20:30:20.904Z",
    "op": "profile",
    "spec": {},
    "outcome": "ok",
    "charged": 0,
    "remaining": 400
  },
  {
    "seq": 4,
    "at": "2026-08-27T20:30:22.021Z",
    "op": "aggregate",
    "spec": {
      "stat": "mean",
      "metric": "baseSalary",
      "groupBy": [
        "gender"
      ]
    },
    "outcome": "ok",
    "charged": 6,
    "remaining": 394
  },
  {
    "seq": 5,
    "at": "2026-08-27T20:30:23.842Z",
    "op": "aggregate",
    "spec": {
      "stat": "mean",
      "metric": "baseSalary",
      "groupBy": [
        "level",
        "gender"
      ]
    },
    "outcome": "ok",
    "charged": 32,
    "remaining": 362
  },
  {
    "seq": 6,
    "at": "2026-08-27T20:30:25.867Z",
    "op": "aggregate",
    "spec": {
      "stat": "mean",
      "metric": "baseSalary",
      "groupBy": [
        "fn",
        "gender"
      ]
    },
    "outcome": "ok",
    "charged": 31,
    "remaining": 331
  },
  {
    "seq": 7,
    "at": "2026-08-27T20:30:27.789Z",
    "op": "adjusted_gap",
    "spec": {
      "metric": "baseSalary",
      "dimension": "gender",
      "reference": "Male",
      "controlFor": [
        "level",
        "fn"
      ]
    },
    "outcome": "ok",
    "charged": 2,
    "remaining": 329
  },
  {
    "seq": 8,
    "at": "2026-08-27T20:30:31.930Z",
    "op": "aggregate",
    "spec": {
      "stat": "mean",
      "metric": "baseSalary",
      "groupBy": [
        "level",
        "location"
      ]
    },
    "outcome": "ok",
    "charged": 75,
    "remaining": 254
  },
  {
    "seq": 9,
    "at": "2026-08-27T20:30:34.049Z",
    "op": "aggregate",
    "spec": {
      "stat": "median",
      "metric": "baseSalary",
      "groupBy": [
        "level"
      ]
    },
    "outcome": "refused",
    "code": "STAT_WITHDRAWN",
    "charged": 1,
    "remaining": 253
  },
  {
    "seq": 10,
    "at": "2026-08-27T20:30:36.369Z",
    "op": "aggregate",
    "spec": {
      "stat": "max",
      "metric": "baseSalary",
      "groupBy": []
    },
    "outcome": "refused",
    "code": "STAT_NOT_PERMITTED",
    "charged": 1,
    "remaining": 252
  },
  {
    "seq": 11,
    "at": "2026-08-27T20:30:38.677Z",
    "op": "aggregate",
    "spec": {
      "stat": "mean",
      "metric": "baseSalary",
      "groupBy": [
        "level",
        "location",
        "gender"
      ]
    },
    "outcome": "refused",
    "code": "GROUP_BY_TOO_DEEP",
    "charged": 1,
    "remaining": 251
  },
  {
    "seq": 12,
    "at": "2026-08-27T20:30:40.996Z",
    "op": "profile",
    "spec": {},
    "outcome": "ok",
    "charged": 0,
    "remaining": 251
  },
  {
    "seq": 13,
    "at": "2026-08-27T20:30:42.226Z",
    "op": "aggregate",
    "spec": {
      "stat": "mean",
      "metric": "baseSalary",
      "groupBy": [
        "level",
        "gender"
      ]
    },
    "outcome": "ok",
    "charged": 32,
    "remaining": 219
  },
  {
    "seq": 14,
    "at": "2026-08-27T20:30:47.077Z",
    "op": "profile",
    "spec": {},
    "outcome": "ok",
    "charged": 0,
    "remaining": 219
  }
]
```