# Natural Language Prompts for the Orchestron Pi Extension

Copy/paste these into a Pi session with the Orchestron extension loaded to test
the registered tools.

## Discovery

- "What Orchestron scores do I have available?"
- "List my registered orchestron workflows."
- "Show me the orchestron scores I can run."
- "Which of my orchestron scores are saved to disk versus just in memory?"

## Starting concerts

- "Run the opencode-demo workflow."
- "Start the jira-to-mr workflow for ticket PROJ-123."
- "Run the simple-plan-review score with topic='obsidian plugins'."
- "Kick off the opencode-demo concert with topic='large language models'."
- "Run the draft score I just created with topic='climate change'."

## Checking status

- "What's the status of that concert?"
- "Check on the orchestron concert I just started."
- "Show me the status of concert `<concert-id>`."
- "Is my orchestron workflow done yet?"

## Listing concerts

- "List my orchestron concerts."
- "Show me my running orchestron concerts."
- "Which orchestron concerts have completed recently?"
- "Show me my failed orchestron concerts."

## Lifecycle

- "Pause my running orchestron concert `<concert-id>`."
- "Cancel the orchestron concert `<concert-id>`."
- "Resume the orchestron concert `<concert-id>`."

## Score authoring

### Creating scores

- "Create a score that analyzes a topic and summarizes it."
- "Create an orchestron workflow that plans a task, reviews the plan, and revises it if needed."
- "Create a new orchestron score called code-review that takes a file path and reviews the code."
- "Create a score with three movements: research, outline, and write."
- "Create a simple orchestron score with structured output."

### Editing scores

- "Show me the YAML for the simple-plan-review score."
- "Edit the simple-plan-review score to add a final delivery step."
- "Add a security review movement to the jira-to-mr score."
- "Change the prompt in the analyze movement of my opencode-demo score."
- "Edit my draft score to use the opencode harness instead of pi."

### Validating and inspecting scores

- "Validate the jira-to-mr score for errors."
- "Is my new score structurally valid?"
- "Show me the full YAML for the score I just created."
- "List my orchestron scores and tell me which ones are saved to disk."
- "Which orchestron scores are only in memory?"

### Draft, test, and persist workflow

- "Create a score that analyzes a topic and summarizes it."
- "Run the draft of my new score to test it."
- "Run the score I just created with topic='machine learning'."
- "That looks good. Save the score."
- "Save my new score to disk."
- "Don't save it yet, just keep it in memory."
- "Now persist the score I created earlier."

### Save location

- "Create a score and save it to the global scores directory."
- "Save this score globally so I can use it in other projects."
- "Save the draft score locally in this project."

### Working with in-memory drafts

- "Create a score in memory only, don't save it yet."
- "List my orchestron scores and show which are persisted."
- "Test the in-memory score I just created."
- "Discard the in-memory draft and overwrite it with this new version."

### Full example conversation

```
User: Create a score that analyzes a topic and summarizes it.
User: Run it with topic='AI agents' to test it.
User: Looks good. Save it.
User: Now edit the score to add a structured output section.
User: Validate the score.
User: Save the updated version.
```
