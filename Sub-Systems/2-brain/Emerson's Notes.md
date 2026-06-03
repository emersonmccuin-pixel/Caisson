# Agents and Pods
Output_destination... is this wise? This is something that should always be set at agent dispatch, no? I just don't want to default this 

Same sort of question with expeceted outoput, could this conflict with the dispatch process?

Scope... shouldn't it also have built-in? There are agents that are built in adn can't be changed (though per project maybe we want to allow them to be adjusted for specifs to that project, and we'd want a system for how to show that per project they're different somehow), global whith means they can show up in any projects's ADD AGENT section and added to the project (they're not accessible globally by orcehstrator to call unless added to a project), then project specifi agents, they can be promoted to global, but the project scoped should remain, it just makes that agent available to other projects thrhoguht he add agent option. 

If we do the above, not sure we need "orgin" for any reason? But maybe.... let me know.

- knowledge, how does the knowledge get used by the agent, is it clean and natural, or is that knowledge just sitting there and not used well by the agent becaue of how the system is set up?
- I'd like to ensure that whatever agent we use to manage agents, it should have the tools to apply knowledge, apply secrets, add tools, etc... it neeeds a full featured "agent management toolkit" and this agent should be built-in and available to the orcehstrator
- we need to do an audit of the basic tools that EVERY AGENT GETS NO MATTER WHAT. And we'll also need to do a full agent audit to discuss tools, descriptions, etc, that can come a bit later after we resolved some of the other things in this whole planned rebuild.
- 
# Agent Deliverables Review

- So some of this stuff needs to come directly from the agent work contract system. The contract should have all the things the agent needs to know for deliverables, and so however we decide it should provide the deliverables should be informed by that sub-system, is that right?
- Ask orchestrator is easy, it asks, goes through the mailbox system, the orchestratror and pick it up and respond. Wheter we want to see that exchange in chat or not we can figure out. I do think we put it in chat and maybe can have a "Filter out these types of messages" option or somethign in CHAT settings for the app. 
	- The ask user situation... I am wondering if we just only have it ask the orchestraatr
	- for human review... we need to work on this as a separate thing entirely. The human review situation should always come through the "Human Inbox System" which we also need to refine. I'd want proper review package, proper review process. Also a global notification system for when human review is needed inother projects and stuff. (lot this)
	- 
# mailbox notification
- mailbox system should go through whatever unified door there is to send messages to where they're supposed to go. If this IS that door, then okay, let's just make sure we nail taht down across all systems.
- We'll need failsafes installed, whatever that may be for missed messages, messages that didn't finish out the message lifecycle. 
- Woudl we want to do something where we do track the message lifecycle. message sent, expecting response, response sent, response received, done. or seotmhing?

# MCP
Yes, main thing is do we want the shape to be 1 MCP server that each claude.exe connects to through HTTP... we gotta spoike that and decide if it's the right path. 

# Orchestrator

# Workflows
- An agentic worfkfow builder needs to be super fuckign smart, it must know everything there is to know about exactly how these are supposed to work and should translate the user intent to a fullyu functioning, proper workflow
- I thinkj for now we do not have triggering on stage entry, it causes too much issue. let's just do an orechetstrator tool for now. 
- STEPs-- I think we want move card to be a step, it's easily reviewable, not burried uner the agent. Loops should be a step. The idea is to loop from review to agent until they get it down.. and loops should have a limit, like 3 steps before it goes to human review and sits in inbox, shit like that. 
- We need to discuss observabiltiy, mainly by the orcehstrator. I want the orchestrator to be able to see everythign that happens in workflows to help debug
- we need to be able to restart workfows at specific stages once the orechestraor does repair
- we need a way to repair workflwos that are broken so the orechestrator can help us work through these issues until we get success then lock in to become the workflow that's repeatble and reliable.
- Passing work down the line... this can't really be discussed without also talking about agent work contracts, as that's ultimately i think what's needed to control passoff? Not sure, we need to talk abotu this and reslove what it looks like. 
- The done signal... this can't really be totally figured out until we talk about mailboxes and what's managing done signal and all that.... 
- 