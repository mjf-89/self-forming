*This file should be edited by humans and humans only. If you are an agent, you can and indeed you should read it to grasp the original spark of the project.*

# Self Forming

Self Forming is an application that shapes itself 
based on what the user request.

Self Forming is a local Harness based on pi-durable.

Self Forming target an Android native app first,
the dream is to target Browser as well. 

Self Forming require only a subscription to your
favorite intelligence provider (currently support 
only ChatGPT and Claude), everything else run on 
your device.

## Why

You can right now built Android and web applications iterating over ChatGPT or Claude apps. 
Especially for Android the iteration loop is long and happens either out there in the cloud or on a local Linux box. 
A lot of people don't have a local Linux box. My partner doesn't have a Linux box. My mom doesn't have a local Linux box, my dad and my brother neither. 
Hell you know what? I don't have a Linux box or a personal PC anymore since years. 
The cloud solution is appealing but the question is why do I need to pay directly or indirectly for a service when I have a perfectly capable computing platform in my pocket? 
I mean, I really like what exe.dev is doing but I spend already money on Intelligence subs, I cannot afford another monthly bill.

The interface should not be dev oriented. 
A developer can come in and shape it's developer experience as he please. 
Normal people will come in and ask what they want without knowledge of what a harness is or what on earth a durable execution framework like pi-durable is.

I envision something minimal, light themed, paper colored, dark grey ink.

## Self Forming on Android 

Yes Self Forming on Android should be able to re-compile
it's kotlin parts. We don't want WebView only slop.

No, Self Forming on Android should NOT require termux
if my poor knowledge is correct a bundled proot 
Ubuntu execution environment + box64 is all we need 
see [here](https://gist.github.com/felix021/b7554306859ee355ef34471a6cc9e948)

As far as I understand pi-durable doesn't need a complex javascript runtime like bun or node.
It should be possible to build a custom runtime with the few dependencies pi-durable need however
it is something outside the scope of this project. As for now we can stick to host the pi-durable
harness in a webview and to build a native bridge towards a kotlin execution environment.
