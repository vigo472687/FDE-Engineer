---
name: brainstormers
description: Structured brainstorming for product, strategy, writing, naming, design, research, debugging, and decision tasks. Use when the user asks to brainstorm, ideate, generate options, explore angles, solve a problem creatively, use SCAMPER, Six Thinking Hats, Reverse Brainstorming, Role Storming, Starbursting, mind mapping, or wants a systematic divergent-thinking session in Codex.
---

# Brainstormers

## Core Workflow

Use this skill to run a structured brainstorming session directly in Codex. Do not require the user to run the original web app.

1. Restate the challenge in one concise sentence.
2. Select one method, unless the user names a method.
3. Generate a first pass with enough variety to be useful.
4. Ask which branch, idea, risk, or option to expand next.
5. When the user wants a decision, switch from divergence to synthesis: cluster, rank, and recommend next actions.

If the request is under-specified, make a reasonable assumption and state it briefly. Ask at most one clarifying question when the missing information would materially change the brainstorming direction.

## Method Selection

Choose the method by fit:

- **Big Mind Mapping**: Use for broad exploration, topic decomposition, strategy maps, product concepts, research areas, content plans, or "what are all the angles?"
- **Reverse Brainstorming**: Use for risk discovery, failure prevention, debugging, quality issues, growth blockers, "what could go wrong?", or improving an existing plan.
- **Role Storming**: Use when perspectives matter: customers, competitors, investors, users, teachers, managers, critics, experts, beginners, or unusual stakeholders.
- **SCAMPER**: Use for improving an existing product, process, feature, campaign, workflow, name, interface, or idea.
- **Six Thinking Hats**: Use for balanced evaluation, group decision support, tradeoff analysis, or separating facts, risks, benefits, emotions, creativity, and process.
- **Starbursting**: Use for question generation, discovery planning, requirements, due diligence, research design, project kickoff, or "what should we ask?"

For ambiguous ideation requests, start with Big Mind Mapping. For requests about improving something concrete, start with SCAMPER. For requests about whether to do something, start with Six Thinking Hats.

## Output Shapes

### Big Mind Mapping

Return a central theme with 5-8 major branches. Each branch should include 3-5 concrete sub-ideas. End with "Promising branches" and name 2-3 branches worth expanding.

### Reverse Brainstorming

Frame the reverse question as "How could we make this fail?" Generate failure paths across product, user, operations, market, technical, financial, legal, and communication dimensions as relevant. Then invert the strongest failure paths into prevention or improvement ideas.

### Role Storming

Pick 4-7 roles that fit the problem. For each role, generate what that role wants, notices, worries about, and would suggest. Include at least one skeptical role and one end-user role when applicable.

### SCAMPER

Use the seven prompts:

- Substitute
- Combine
- Adapt
- Modify or magnify/minify
- Put to another use
- Eliminate
- Reverse or rearrange

For each prompt, produce 2-4 ideas. Keep ideas specific to the user's object, not generic creativity advice.

### Six Thinking Hats

Use the hats as separate lenses:

- White: facts, unknowns, evidence needed
- Red: feelings, intuition, stakeholder reactions
- Black: risks, constraints, downsides
- Yellow: benefits, upside, reasons it could work
- Green: alternatives, experiments, creative moves
- Blue: process, decision frame, next steps

End with a short synthesis and a recommended next move.

### Starbursting

Generate questions instead of answers. Organize by:

- Who
- What
- When
- Where
- Why
- How

Prioritize the top 5-10 questions to answer first.

## Expansion Modes

When the user asks to continue, choose the smallest useful expansion:

- **Deepen**: take one idea and add variants, implementation details, risks, and examples.
- **Broaden**: add more branches or roles.
- **Combine**: merge ideas into concepts or strategies.
- **Rank**: score ideas by impact, effort, novelty, confidence, or risk.
- **Actionize**: convert ideas into experiments, roadmap items, prompts, specs, or checklists.

## Response Style

Be concrete, structured, and generative. Prefer compact tables only when comparison helps. Keep the first pass broad enough to create options, then help the user narrow.

Avoid presenting brainstorming frameworks as theory unless the user asks. The value is the generated ideas.
