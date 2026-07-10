---
status: "In progress"
priority: "Medium"
due:  no
---
# Dataview Demo

## Active projects
```dataview
TABLE status, priority, due FROM #project WHERE status != "done" SORT priority ASC
```

## All projects as a list
```dataview
LIST FROM #project SORT file.name
```

## Open tasks
```dataview
TASK FROM #project WHERE !completed
```

## Grouped
```dataview
TABLE rating FROM #project GROUP BY status
```

Inline: Alpha rating is `= 8` and today is `= dateformat(now(), "yyyy-MM-dd")`.

## Editable table
| Name | Status | Notes   |
| ---- | ------ | ------- |
| Beta | done   | shipped |
|      |        |         |
|      |        |         |
