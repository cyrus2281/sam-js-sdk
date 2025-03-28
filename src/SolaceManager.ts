import solace, { SolclientFactory } from "solclientjs";
import {
  BrokerConfig,
  Message,
  PublishOptions,
  UserPropertiesMap,
} from "./interfaces";

type onMessageCallback = (message: Message) => void;

const factoryProps = new solace.SolclientFactoryProperties();
factoryProps.profile = solace.SolclientFactoryProfiles.version10_5;
SolclientFactory.init(factoryProps);
SolclientFactory.setLogLevel(solace.LogLevel.DEBUG);

class SolaceManager {
  private session: solace.Session | undefined;
  private isConnected = false;
  private onMessage!: onMessageCallback;
  private brokerConfig!: BrokerConfig;
  private inactivityTimeout: NodeJS.Timeout | null = null;
  private ignoreTopics: RegExp[] = [];
  private onConnectionStateChange!: (
    isConnected: boolean,
    error: string | null
  ) => void;

  constructor(config: BrokerConfig, private brokerDisconnectTimeout: number) {
    this.brokerConfig = config;
  }

  resetInactivityTimeout() {
    if (!this.brokerDisconnectTimeout) {
      return;
    }
    if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
    this.inactivityTimeout = setTimeout(() => {
      this.disconnect();
    }, this.brokerDisconnectTimeout);
  }

  shouldIgnoreMessage(topic: string) {
    if (!this.ignoreTopics.length) {
      return false;
    }
    return this.ignoreTopics.some((ignoreTopic) => ignoreTopic.test(topic));
  }

  handleMessage(message: solace.Message) {
    this.resetInactivityTimeout();
    const destination = message.getDestination();
    const topic = destination ? destination.getName() : "unknown";
    if (this.shouldIgnoreMessage(topic)) {
      console.debug("Ignoring message for topic:", topic);
      return;
    }
    const payload = message.getBinaryAttachment()?.toString() ?? "";
    const metadata: Message["metadata"] = {
      deliveryMode: message.getDeliveryMode(),
      isDMQEligible: message.isDMQEligible(),
      ttl: message.getTimeToLive(),
      priority: message.getPriority(),
      replyTo: message.getReplyTo()?.getName() || null,
      senderId: message.getSenderId(),
      correlationId: message.getCorrelationId(),
      redelivered: message.isRedelivered(),
      senderTimestamp: message.getSenderTimestamp(),
      receiverTimestamp: message.getReceiverTimestamp() ?? Date.now(),
    };

    const userProperties: { [key: string]: unknown } = {};
    const userPropertyMap = message.getUserPropertyMap();
    if (userPropertyMap) {
      userPropertyMap.getKeys().forEach((key) => {
        const field = userPropertyMap.getField(key);
        userProperties[key] = {
          type: field.getType(),
          value: field.getValue(),
        };
      });
    }
    const uid = Math.random().toString(36).substring(7) + Date.now();
    const messageObj = {
      topic,
      payload,
      userProperties,
      metadata,
      _extension_uid: uid,
    };
    console.debug("Received message:", messageObj);
    this.onMessage(messageObj);
  }

  async connect(config?: BrokerConfig) {
    if (config) {
      this.brokerConfig = config;
    }
    try {
      // Initialize Solace client factory
      SolclientFactory.init();

      // Create session
      const properties = new solace.SessionProperties({
        url: this.brokerConfig.url,
        vpnName: this.brokerConfig.vpn,
        userName: this.brokerConfig.username,
        password: this.brokerConfig.password,
      });

      this.session = SolclientFactory.createSession(properties);

      // Define session event listeners
      this.session.on(solace.SessionEventCode.UP_NOTICE, () => {
        this.isConnected = true;
        this.resetInactivityTimeout();
        console.debug("Solace session connected");
        if (this.onConnectionStateChange) {
          this.onConnectionStateChange(this.isConnected, null);
        }
      });

      this.session.on(
        solace.SessionEventCode.CONNECT_FAILED_ERROR,
        (sessionEvent) => {
          this.isConnected = false;
          console.error("Solace connection failed:", sessionEvent.message);
          if (this.onConnectionStateChange) {
            this.onConnectionStateChange(
              this.isConnected,
              sessionEvent.message
            );
          }
        }
      );

      this.session.on(solace.SessionEventCode.DISCONNECTED, () => {
        this.isConnected = false;
        console.debug("Solace session disconnected");
        if (this.onConnectionStateChange) {
          this.onConnectionStateChange(this.isConnected, null);
        }
      });

      // Connect the session
      this.session.connect();
    } catch (error) {
      console.error("Error creating Solace session:", error);
      throw error;
    }

    this.session.on(
      solace.SessionEventCode.MESSAGE,
      this.handleMessage.bind(this)
    );
  }

  addUserPropertiesToMessage(
    message: solace.Message,
    userProperties: UserPropertiesMap
  ) {
    let userPropertyMap = message.getUserPropertyMap();
    if (!userPropertyMap) {
      userPropertyMap = new solace.SDTMapContainer();
    }
    Object.keys(userProperties).forEach((key) => {
      userPropertyMap.addField(
        key,
        userProperties[key].type,
        userProperties[key].value
      );
    });
    message.setUserPropertyMap(userPropertyMap);
  }

  setOnMessage(onMessage: onMessageCallback) {
    this.onMessage = onMessage;
  }

  setOnConnectionStateChange(
    onConnectionStateChange: (
      isConnected: boolean,
      error: string | null
    ) => void
  ) {
    this.onConnectionStateChange = onConnectionStateChange;
  }

  setIgnoreTopics(ignoreTopics: string[]) {
    this.ignoreTopics = ignoreTopics.map(
      (topic) => new RegExp(topic.replace(/\*/g, "[^/]+").replace(">", ".*"))
    );
    console.log("Ignoring topics:", this.ignoreTopics);
  }

  getBrokerConfig() {
    return this.brokerConfig;
  }

  getConnectionState() {
    return this.isConnected;
  }

  subscribe(topic: string) {
    try {
      if (!this.session) {
        throw new Error("Session not initialized");
      }
      this.session.subscribe(
        SolclientFactory.createTopicDestination(topic),
        true,
        topic,
        10000
      );
      console.log("Subscribed to topic:", topic);
    } catch (subscribeError) {
      console.error("Error subscribing to topic:", topic, subscribeError);
    }
  }

  unsubscribe(topic: string) {
    try {
      if (!this.session) {
        throw new Error("Session not initialized");
      }
      this.session.unsubscribe(
        SolclientFactory.createTopicDestination(topic),
        true,
        topic,
        10000
      );
      console.log("Unsubscribed from topic:", topic);
    } catch (unsubscribeError) {
      console.error("Error unsubscribing from topic:", topic, unsubscribeError);
    }
  }

  consumeQueue(
    name: string,
    type: solace.QueueType,
    topic: string | undefined,
    onError: (error: Error) => void
  ) {
    try {
      if (!this.session) {
        throw new Error("Session not initialized");
      }

      const consumerProperties = new solace.MessageConsumerProperties();
      consumerProperties.queueDescriptor = new solace.QueueDescriptor({
        name,
        type,
      });

      if (type === solace.QueueType.TOPIC_ENDPOINT && topic) {
        consumerProperties.topicEndpointSubscription =
          SolclientFactory.createTopicDestination(topic);
      }

      const messageConsumer =
        this.session.createMessageConsumer(consumerProperties);

      messageConsumer.on(
        solace.MessageConsumerEventName.MESSAGE,
        this.handleMessage.bind(this)
      );

      messageConsumer.on(
        solace.MessageConsumerEventName.CONNECT_FAILED_ERROR,
        (error) => {
          onError(error);
          console.log("Consumer connect failed:", error);
          messageConsumer.disconnect();
        }
      );

      // Set up other event listeners as needed
      messageConsumer.connect();

      return messageConsumer;
    } catch (consumeError) {
      console.error("Error consuming queue:", name, consumeError);
    }
  }

  publish(
    name: string,
    content: string,
    options: PublishOptions = {}
  ): Error | void {
    try {
      if (!this.session) {
        throw new Error("Session not initialized");
      }
      this.resetInactivityTimeout();
      const message = SolclientFactory.createMessage();
      if (options.destinationType !== undefined) {
        if (options.destinationType === solace.DestinationType.QUEUE) {
          message.setDestination(
            SolclientFactory.createDurableQueueDestination(name)
          );
        } else if (options.destinationType === solace.DestinationType.TOPIC) {
          message.setDestination(SolclientFactory.createTopicDestination(name));
        }
      } else {
        message.setDestination(SolclientFactory.createTopicDestination(name));
      }
      if (options.deliveryMode !== undefined) {
        message.setDeliveryMode(options.deliveryMode);
      }
      if (options.dmqEligible !== undefined) {
        message.setDMQEligible(options.dmqEligible);
      }
      if (options.replyToTopic !== undefined) {
        message.setReplyTo(
          SolclientFactory.createTopicDestination(options.replyToTopic)
        );
      }
      if (options.priority !== undefined) {
        message.setPriority(options.priority);
      }
      if (options.timeToLive !== undefined) {
        message.setTimeToLive(options.timeToLive * 1e3);
      }
      if (options.correlationId !== undefined) {
        message.setCorrelationId(options.correlationId);
      }
      if (options.messageType === solace.MessageType.BINARY) {
        message.setSdtContainer(
          solace.SDTField.create(solace.SDTFieldType.STRING, content)
        );
      } else {
        message.setBinaryAttachment(content);
      }
      if (
        options.userProperties &&
        Object.keys(options.userProperties).length
      ) {
        this.addUserPropertiesToMessage(message, options.userProperties);
      }
      this.session.send(message);
      console.debug("Published message:", name, content, options);
      return;
    } catch (publishError: unknown) {
      console.error("Error publishing message:", name, content, publishError);
      return publishError as Error;
    }
  }

  disconnect() {
    if (this.session) {
      console.log("Disconnecting Solace session.");
      this.session.removeAllListeners();
      this.session.disconnect();
      this.isConnected = false;
      this.session = undefined;
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(this.isConnected, null);
      }
      if (this.inactivityTimeout) {
        clearTimeout(this.inactivityTimeout);
      }
    }
  }
}

export default SolaceManager;
