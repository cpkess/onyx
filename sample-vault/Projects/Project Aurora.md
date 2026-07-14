
```dataview
TABLE status
WHERE parent = "Project Aurora"
%% onyx-badges: {"status":[{"value":"On Track","color":"green"},{"value":"At Risk","color":"amber"},{"value":"Help Needed","color":"red"},{"value":"Complete","color":"blue"}]} %%
```


---
type: project
---

# Project Aurora

Owner: [[Priya]] · Design: [[Dana]]

Next-gen analytics dashboard. This page mostly builds itself — the sections below
pull from every note that links to Project Aurora, and from its sub-projects.

## Epics & sub-projects

```dataview
TABLE status
WHERE parent = "Project Aurora"
SORT file.name ASC
```
The `children` primitive lists notes whose `parent` points here.

```onyx-primitive
type: children
```

## Open work
```onyx-primitive
type: todo
```

## Decisions
```onyx-primitive
type: decisions
```

## Discussed in
```onyx-primitive
type: mentions
```
