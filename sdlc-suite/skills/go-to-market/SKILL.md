---
name: go-to-market
version: 1.0.0
description: Turning an opportunity into a testable go-to-market case — purpose, who it is for, what the buyer achieves, business model, positioning, the first channel, a pricing hypothesis, how to land the first ten customers, and the kill criteria. Load when framing whether and how a new product, feature or prototype could reach paying users. Do NOT use for finding the problem behind a requested solution (that is `business-analysis`) or for sequencing several initiatives (that is `roadmapping`).
---

# Go-to-Market

A go-to-market case is a set of **hypotheses about who pays, why, and how they
hear about it**. Each one is cheap to test before it is expensive to be wrong
about. The case is worth writing before a prototype is built, and the
prototype exists to test its riskiest line.

## The case, in order

1. **Purpose.** Write one sentence: what changes for someone when this exists.
   If it needs "and", it is two products.
2. **Who it is for.** Name the narrowest group that feels the pain weekly: a
   role in a kind of company, or a person in a situation. "Developers" and
   "SMBs" are markets, not customers.
3. **The problem in their words.** Describe what they do today instead (the
   workaround, the tool, the spreadsheet, the person they pay), and what it
   costs them in time, money or risk. No current workaround usually means no
   pain.
4. **What they can achieve.** State the outcome the buyer gets, in a unit they
   already measure, such as hours a week, error rate, revenue or
   time-to-something. This is what the pitch and the prototype demonstrate.
5. **Business model.** Say who pays, for what unit (seat, usage, outcome,
   one-off), and roughly how much. Anchor the price to the cost of the current
   workaround, not to your cost.
6. **Positioning.** Use the shape "For <who> who <pain>, <product> is a
   <category> that <outcome>, unlike <current alternative>." If the
   alternative is "nothing", re-check step 3.
7. **First channel.** Pick one, not five. Choose the place this group already
   gathers or searches (a community, a marketplace, an integration directory,
   outbound to a list you can actually build), and say why it reaches *them*.
8. **First ten customers.** Say concretely how you would find, contact and
   convert the first ten. Name real places and real lists. If you cannot,
   that is the finding.
9. **Riskiest assumption.** Name the single line above that, if false, kills
   the case. The prototype and the first experiment target it.
10. **Kill criteria.** Set a measurable result and a deadline that would make
    you stop. For example: "fewer than 3 of 20 target users ask for access
    within 2 weeks."

## Evidence discipline

As in `business-analysis`, label every claim:
- a **known fact** (cited data or a measured result)
- a **hypothesis** (testable; give the test)
- an **assumption** (no evidence yet)

A case built from a news item is almost all hypotheses. Saying so is the
honest version, not a weaker one. Never invent market sizes, customer quotes
or competitor numbers. If a figure matters and you do not have it, write
"unknown — measure by <test>".

## Common failure modes

- **Timing as the only moat.** "X was just released" is a reason to look, not
  a business. Ask what stays true once everyone has read the same news.
- **The feature is the product.** If an incumbent can ship it as a checkbox,
  the case needs a distribution edge or a workflow the incumbent will not
  build.
- **Everyone is the customer.** If the ICP cannot be found in a list or a
  community, the first channel cannot exist either.
- **Price set by cost.** The buyer compares against their alternative, not
  your spend.

## Handing off

- `sdlc-suite:product-manager` owns the decision to pursue. This case is its
  input, not the decision.
- `sdlc-suite:prototyper` builds the demo of step 4's outcome.
- The Hermes `icp-builder` skill deepens step 2 when the segment is unclear.
