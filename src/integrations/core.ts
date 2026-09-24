import { superdevClient } from "../lib/superdev/client";

export const core = superdevClient.integrations.core;
export const uploadFile = superdevClient.integrations.core.uploadFile;
export const invokeLLM = superdevClient.integrations.core.invokeLLM;
export const generateImage = superdevClient.integrations.core.generateImage;
export const editImage = superdevClient.integrations.core.editImage;
export const getUploadedFile = superdevClient.integrations.core.getUploadedFile;
export const sendEmail = superdevClient.integrations.core.sendEmail;
export const extractDataFromUploadedFile =
  superdevClient.integrations.core.extractDataFromUploadedFile;
export const contacts = superdevClient.integrations.core.contacts;
export const events = superdevClient.integrations.core.events;
export const textAgentChat = superdevClient.integrations.core.textAgentChat;
export const createVoiceWebCall =
  superdevClient.integrations.core.createVoiceWebCall;
export const createVoiceOutboundCall =
  superdevClient.integrations.core.createVoiceOutboundCall;
