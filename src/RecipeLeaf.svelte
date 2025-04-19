<script lang="ts">
	import { onMount } from "svelte";
	import { App } from "obsidian";

	export let childNodesOf: HTMLElement;
	export let asTag: string;
    export let app: App; // Pass the Obsidian app instance to this component
    export let lineIndex: number; // The line number of the checkbox in the markdown file

	let root: HTMLElement;

	function handleCheckboxChange(e: Event) {
			const isChecked = (e.target as HTMLInputElement).checked;

			// Update the markdown
			const file = app.workspace.getActiveFile();
			if (!file) {
				console.warn("No active file found.");
				return;
			}

			app.vault.read(file).then((content: string) => {
				const lines = content.split("\n");

				// Update the specific line with the new checkbox state
				const updatedLine = lines[lineIndex].replace(
					/^\s*-\s*\[.\]/, // Match the checkbox syntax
					`- [${isChecked ? "x" : " "}]`
				);

				lines[lineIndex] = updatedLine;

				// Write the updated content back to the file
				app.vault.modify(file, lines.join("\n")).then(() => {
					console.log("Markdown updated successfully.");
				});
			});
	}


	// We just borrow the original node's children, and return them when we're done
	onMount(() => {
		Array.from(childNodesOf.childNodes).forEach((node) => {
			root.appendChild(node);
		});

		for (var dataAttr in childNodesOf.dataset) {
			root.setAttr("data-" + dataAttr, childNodesOf.dataset[dataAttr]!);
		}

		// If we were passed an app instance, then we know this is a recipe ingredient list item
		// and we need to add a change handler to the checkbox so we can update the markdown.
		if (app) {
			// Add an on:change handler to the real checkbox
			const realCheckbox = root.querySelector(".task-list-item-checkbox") as HTMLInputElement;
			if (realCheckbox) {
				// Remove any existing listeners to avoid duplicates - this parsing can happen multiple times during the rendering process.
				realCheckbox.removeEventListener("change", handleCheckboxChange); 
				realCheckbox.addEventListener("change", handleCheckboxChange);
			}
		}

		return () => {
			if (root)
				Array.from(root.childNodes).forEach((node) => {
					childNodesOf.appendChild(node);
				});
		};
	});
</script>

<div>
	<svelte:element this={asTag} bind:this={root} class="recipe-leaf" />
</div>
