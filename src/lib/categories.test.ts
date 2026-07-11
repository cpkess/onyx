import { describe, it, expect } from "vitest";
import {
  categoryByTrigger,
  categoryById,
  pageInCategory,
  notesInCategory,
  newCategoryNoteBody,
} from "./categories";
import type { Category } from "../settings";
import type { Page } from "./api";

const person: Category = { id: "person", name: "Person", folder: "People", trigger: "@", template: "" };
const project: Category = { id: "project", name: "Project", folder: "Projects", trigger: "+", template: "" };
const cats = [person, project];

function page(over: Partial<Page>): Page {
  return {
    path: "x.md",
    name: "x",
    folder: "",
    tags: [],
    mtime: 0,
    ctime: 0,
    size: 0,
    fields: {},
    tasks: [],
    outlinks: [],
    inlinks: [],
    ...over,
  };
}

describe("categoryByTrigger / categoryById", () => {
  it("finds by trigger char and id", () => {
    expect(categoryByTrigger("@", cats)).toBe(person);
    expect(categoryByTrigger("+", cats)).toBe(project);
    expect(categoryByTrigger("#", cats)).toBeUndefined();
    expect(categoryById("project", cats)).toBe(project);
  });
  it("ignores empty triggers", () => {
    const noTrigger = [{ ...person, trigger: "" }];
    expect(categoryByTrigger("", noTrigger)).toBeUndefined();
  });
});

describe("pageInCategory", () => {
  it("matches by folder (direct and nested)", () => {
    expect(pageInCategory(page({ folder: "People" }), person)).toBe(true);
    expect(pageInCategory(page({ folder: "People/Team" }), person)).toBe(true);
    expect(pageInCategory(page({ folder: "Projects" }), person)).toBe(false);
  });
  it("matches by the type field regardless of folder", () => {
    expect(pageInCategory(page({ folder: "", fields: { type: "person" } }), person)).toBe(true);
    expect(pageInCategory(page({ fields: { type: "PERSON" } }), person)).toBe(true);
    expect(pageInCategory(page({ fields: { type: ["a", "project"] } }), project)).toBe(true);
  });
  it("returns false for unrelated notes", () => {
    expect(pageInCategory(page({ folder: "Daily", fields: { type: "daily" } }), person)).toBe(false);
  });
});

describe("notesInCategory", () => {
  it("collects candidate names", () => {
    const pages = [
      page({ name: "Jane Doe", folder: "People" }),
      page({ name: "Bob", fields: { type: "person" } }),
      page({ name: "Alpha", folder: "Projects" }),
    ];
    expect(notesInCategory(pages, person).sort()).toEqual(["Bob", "Jane Doe"]);
    expect(notesInCategory(pages, project)).toEqual(["Alpha"]);
  });
});

describe("newCategoryNoteBody", () => {
  it("stamps the type frontmatter and a default H1", () => {
    const body = newCategoryNoteBody(person, "Jane Doe", "");
    expect(body).toBe("---\ntype: person\n---\n\n# Jane Doe\n");
  });
  it("adds a parent link when given", () => {
    const body = newCategoryNoteBody(project, "Epic 1", "", "Project Alpha");
    expect(body).toContain('parent: "[[Project Alpha]]"');
    expect(body).toContain("type: project");
  });
  it("substitutes the template when provided", () => {
    const body = newCategoryNoteBody(person, "Jane", "Hi {{title}}!");
    expect(body).toContain("Hi Jane!");
    expect(body.startsWith("---\ntype: person\n---")).toBe(true);
  });
});
