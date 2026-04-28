import type { AuthOTPEmailProps } from "../emails";
import { AuthOTPEmail } from "../emails";

export default function AuthOTPPreview(props: AuthOTPEmailProps) {
  return <AuthOTPEmail {...props} />;
}

AuthOTPPreview.PreviewProps = {
  otp: "739105",
};
