# Agent Host
So if the APP itself goes down, this still dies. Is there an agent resume process if this happens?
Where would that live and is it wise to build? I dont' want users losing valuable work before they accidently closed the app or it freezes/crashes.

Is there limit to how many agent proceses cna run so we don't overload the system? 
Can we set that in app settings?

These commands the host understands... could we expose some (or all) of these as tools an orchestrarorr or the CAISSON agent could access through a "tool search" tool. I want to avoid dumping all the tools on them in their prompt or at load, but want them to be able to access if needed to diagnost stuff to the user.  And some of the tools to manage agent lifecycle SHOULD be first order tools the orcehstrtaor knows about and can use. 

I like the overall direction of this, but how can we ensure that we're building correctly, not repeating shitty patterns that we built before... we want first principles, what's the best structure for these elements. 



# Agent Run Lifecycle
How do we truly tell if an agent is working? It can run for a long time doing stuff, and if there's not a reliable mechanism to understand that it's doing stuff, it could be killed by a timeout process, which loses user trust, burrns usage, etc. 

There's lots of "Scar Tissue" stuff in this... i want to make sure that we're not hardwirign these fixes into the code when we SHOULD be fixing the underlying, foundational issues. 

# Runtime PTY

The main thing here... we need a reliable way to flag "Claude is Ready" and for that to be clear in the UI to the user... this is especialy important for orcehstartro sessions "Claude is Loading" or something, greyed out chat input and a loading spinner. SOMETHING to provide feedback to the user. 

# Transcript Tailers
I guess this all seems fine. Not totally sure!
