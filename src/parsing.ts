import RecipeViewPlugin from "./main";
import RecipeLeaf from "./RecipeLeaf.svelte";
import CheckableIngredientList from "./CheckableIngredientList.svelte";
import SelectableStepList from "./SelectableStepList.svelte";
import { App, Component, MarkdownRenderer } from "obsidian";
import store from "./store"
import { Writable, get, writable } from "svelte/store"
import Fraction from "fraction.js";
import { matchQuantities } from "./quantities";
import ScaledQuantity from "./ScaledQuantity.svelte";
import { ComponentType } from "svelte";


export interface ParsedRecipeComponent {
    type: ComponentType;
    props: Record<string, unknown>;
    origIndex: number;
}

export interface ParsedRecipeSection {
    containsHeader: boolean;
    sideComponents: Array<ParsedRecipeComponent>;
    mainComponents: Array<ParsedRecipeComponent>;
}
export interface ParsedRecipe {
    title: string;
    thumbnailPath: string;
    sections: Array<ParsedRecipeSection>;
    renderedMarkdownParent: HTMLElement;
    qtyScaleStore: Writable<Fraction>;
}

function parseForQty(n: Node, qtyScaleStore: Writable<Fraction>) {
    if (n.nodeType == Node.ELEMENT_NODE) {
        if (
            (n as HTMLElement).hasAttribute("data-qty") ||
            (n as HTMLElement).hasAttribute("data-qty-no-parse")
        ) {
            return;
        }
    }

    if (n.nodeType == Node.TEXT_NODE) {
        const parent = n.parentNode!;
        let currentIndex = 0;
        n.textContent = n.textContent!.normalize("NFKD").replaceAll("\u2044", "/");
        for (const match of matchQuantities(n.textContent!)) {
            parent.insertBefore(
                document.createTextNode(
                    n.textContent!.slice(currentIndex, match.index)
                ),
                n
            );
            const qtyTarget = createEl("span");
            qtyTarget.setAttribute("data-qty", "true");
            parent.insertBefore(qtyTarget, n);
            new ScaledQuantity({
                target: qtyTarget,
                props: {
                    value: match.value.value,
                    format: match.value.format,
                    unit: match.unit,
                    qtyScaleStore: qtyScaleStore,
                },
            });
            currentIndex = (match.index || currentIndex) + match.length;
        }
        parent.insertBefore(
            document.createTextNode(n.textContent!.slice(currentIndex)),
            n
        );
        parent.removeChild(n);
    }

    if (n.hasChildNodes()) {
        Array.from(n.childNodes).forEach((c) =>
            parseForQty(c, qtyScaleStore)
        );
    }
}

function injectQuantities(parsedRecipe: ParsedRecipe) {
    parsedRecipe.sections.flatMap((s) => s.sideComponents.concat(s.mainComponents)).map((c) => {
        switch (c.type) {
            case RecipeLeaf:
                Array.from((c.props.childNodesOf as HTMLElement).querySelectorAll("[data-qty-parse]"))
                    .forEach((n) => parseForQty(n, parsedRecipe.qtyScaleStore));
                break;

            case SelectableStepList:
                if (c.props.kind == "ol") {
                    Array.from((c.props.list as HTMLElement).querySelectorAll("[data-qty-parse]"))
                        .forEach((n) => parseForQty(n, parsedRecipe.qtyScaleStore));
                } else {
                    (c.props.list as Array<HTMLElement>).forEach((p) => {
                        Array.from(p.querySelectorAll("[data-qty-parse]"))
                            .forEach((n) => parseForQty(n, parsedRecipe.qtyScaleStore));
                    })
                }
                break;

            case CheckableIngredientList:
                parseForQty((c.props.list as HTMLElement), parsedRecipe.qtyScaleStore);
                break;

            default:
                break;
        }
    })
}

export function preprocessMarkdown(text: string, hiddenTags: string[]): string {
    // Create a regex pattern to match the hidden tags
    // The regex will match lines that contain only the hidden tags
    // and ignore any other content.
    const tagRegex = new RegExp(`^\\s*(${hiddenTags.map(tag => `#${tag}`).join("|")})\\s*$`, "i");
    
    // Filter out lines that match the tag regex
    const filteredLines = text.split("\n").filter((line) => !tagRegex.test(line));

    return filteredLines.join("\n");
}

export function renderFilteredMarkdown(
    app: App,
    text: string,
    container: HTMLElement,
    path: string,
    view: Component,
    hiddenTags: string[] = []
) {
    // Preprocess the Markdown to filter out unwanted tags
    const filteredText = preprocessMarkdown(text, hiddenTags);

    // Render the filtered Markdown
    MarkdownRenderer.render(app, filteredText, container, path, view);
}

export function parseRecipeMarkdown(
    plugin: RecipeViewPlugin, text: string, path: string, component: Component
) {
    // Create our object to store the result.
    // - When we want to render HTML elements created from rendering the markdown, we need
    // to reparent them rather than clone them (or e.g. callout icons, transclusions,
    // etc. get lost.) As such, every element being rendered directly from the rendered
    // markdown needs to be wrapped in a RecipeLeaf, which ensures it doesn't get
    // destroyed if the components get rebuilt e.g. because the layout changes.
    const result: ParsedRecipe = {
        title: "",
        thumbnailPath: "",
        sections: [{
            containsHeader: false,
            sideComponents: [],
            mainComponents: [],
        }],
        renderedMarkdownParent: createDiv(),
        qtyScaleStore: writable(new Fraction(1)),
    };

    renderFilteredMarkdown(plugin.app, text, result.renderedMarkdownParent, path, component, plugin.settings.hiddenTags);

    const radioName = `selectable-steps-${get(store.counter)}`;
    store.counter.update((n) => n + 1);

    const sideColumnRegex = RegExp(plugin.settings.sideColumnRegex, "i");

    let currentSection = 0;
    let currentColumn = "mainComponents";

    let sendToSideUntilLevel = 7;
    for (let i = 0; i < result.renderedMarkdownParent.children.length; i++) {
        const item = result.renderedMarkdownParent.children.item(i)!;

        // Horizontal rules will create a new section
        if (item.nodeName == "HR") {
            result.sections.push({
                containsHeader: false,
                sideComponents: [],
                mainComponents: [],
            });
            currentSection++;
            currentColumn = "mainComponents"
            sendToSideUntilLevel = 7;
            continue; // Don't include the HR to be rendered
        }

        // Headers can change which column to send items to
        if (item.nodeName.match(/H[1-6]/)) {
            const headerLevel = parseInt(item.nodeName.at(1)!);
            if (
                plugin.settings.treatH1AsFilename &&
                headerLevel == 1 &&
                result.sections[currentSection].containsHeader == false
            ) {
                result.title = item?.textContent || "";
                continue;
            } else {
                result.sections[currentSection].containsHeader = true;
            }
            if (
                item.textContent?.match(sideColumnRegex)
            ) {
                currentColumn = "sideComponents";
                sendToSideUntilLevel = headerLevel;
            } else if (
                currentColumn == "sideComponents" &&
                headerLevel <= sendToSideUntilLevel
            ) {
                currentColumn = "mainComponents";
                sendToSideUntilLevel = 7;
            }
        }

        // To stop margins from not collapsing below the title block,
        // get rid of the display: none frontmatter
        if (item.matches("pre.frontmatter")) {
            continue;
        }

        // Extract the first image as a thumbnail
        if (
            item.getElementsByTagName("IMG").length > 0 &&
            currentSection == 0 &&
            !result.thumbnailPath &&
            !result.sections[0].containsHeader
        ) {
            result.thumbnailPath = item
                .getElementsByTagName("IMG")
                .item(0)?.getAttribute("src") || "";
            continue; // Don't send to either column
        }

        // If it's an unordered list, make it checkable if either:
        // 1. it's going to the sidebar, or
        // 2. we haven't seen a header yet (and then send it there)
        if (
            item.nodeName == "UL" &&
            (currentColumn == "sideComponents" || !result.sections[currentSection].containsHeader)
        ) {
            // We need to parse the original markdown to determine the line number
            // where the list starts, so we can set the origIndex correctly for the list.
            // This is because the rendered markdown doesn't have the same line numbers
            // as the original markdown.
            // Since there can be multiple lists in the markdown file, we need to find the right list based
            // on content.  So we'll need to do some pattern matching to find the right list. 

            // Parse the original Markdown to determine the line number where the list starts
            const markdownLines = text.split("\n"); // Split the Markdown into lines
            const listItems = Array.from(item.querySelectorAll("li")); // Get all list items in the rendered list

            // Find the starting line of the list in the Markdown
            let listStartLine = -1;
            for (let lineIndex = 0; lineIndex < markdownLines.length; lineIndex++) {
                const line = markdownLines[lineIndex].trim();

                // Check if the line matches the first list item
                if (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("+ ")) {
                    const listItemText = listItems[0]?.textContent?.trim() || "";
                    if (line.includes(listItemText)) {
                        listStartLine = lineIndex;
                        break;
                    }
                }
            }

            // If we found the starting line, use it as the origIndex
            const origIndex = listStartLine !== -1 ? listStartLine : i;


            result.sections[currentSection]["sideComponents"].push({
                type: CheckableIngredientList,
                props: { app: plugin.app, list: item, bullets: plugin.settings.showBulletsTwoColumn, origIndex:origIndex},
                origIndex: i,
            });
            continue;
        }

        // If we're sending an ordered list to the main column, then make it selectable
        if (item.nodeName == "OL" && currentColumn == "mainComponents") {
            result.sections[currentSection][currentColumn].push({
                type: SelectableStepList,
                props: {
                    list: item,
                    kind: "ol",
                    radioName: radioName,
                },
                origIndex: i,
            });
            continue;
        }

        // If we're sending a paragraph to the main column, then make it selectable
        if (item.nodeName == "P" && currentColumn == "mainComponents") {
            const prev = result.sections[currentSection][currentColumn][result.sections[currentSection][currentColumn].length - 1];
            if (
                prev &&
                prev.type == SelectableStepList &&
                prev.props.kind == "p"
            ) {
                (prev.props.list as Array<HTMLElement>).push(item as HTMLElement);
            } else {
                result.sections[currentSection][currentColumn].push({
                    type: SelectableStepList,
                    props: {
                        list: [item],
                        kind: "p",
                        radioName: radioName,
                    },
                    origIndex: i,
                });
            }
            continue;
        }

        // If it's a callout, that's a top-level div so we need to wrap it or we'll
        // steal its children without the actual <div class='callout'> around them
        if (item.hasClass("callout")) {
            const calloutWrapper = createDiv();
            calloutWrapper.appendChild(item);
            // @ts-ignore
            result.sections[currentSection][currentColumn].push({
                type: RecipeLeaf,
                props: { childNodesOf: calloutWrapper, asTag: "div" },
                origIndex: i,
            });
            // because we reparented the callout, if we don't fix the index it'll skip
            // the next block
            i -= 1;
            continue;
        }

        // Add current item to current column
        // @ts-ignore
        result.sections[currentSection][currentColumn].push({
            type: RecipeLeaf,
            props: { childNodesOf: item, asTag: item.nodeName },
            origIndex: i,
        });
    }

    injectQuantities(result);

    return result;
}